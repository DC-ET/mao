package cn.etarch.mao.app;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 待确认事件队列（可靠投递核心）：
 * - 全局单调 sequence（冷启动从 meta 与磁盘文件最大值恢复，避免冲突）
 * - JS 累计 ACK（最大连续 seq，空洞由 tombstone/skipped 允许前移）
 * - 后台模式事件追加写 events.jsonl（tmp + fsync + 原子 rename）
 * - pending-meta.json 持久化：nextSequence / lastAckSequence / skipped / restSyncRequired
 * - 每会话未 ACK 上限（5000 条 / 10MB），溢出丢最旧并记 tombstone + 标记 REST 校准
 * - compact：recovery 完成后重写磁盘文件（失败保留原文件）
 *
 * 崩溃一致性：所有文件写入先写临时文件 → fsync → 原子 rename；元数据与数据文件
 * 不要求强事务，不一致时保守标记 REST 校准。
 *
 * 目录：context.getNoBackupFilesDir()/buffered-events/&lt;userId&gt;/
 */
public class PendingQueue {

    private static final String TAG = "MaoPendingQueue";
    private static final String EVENTS_FILE = "events.jsonl";
    private static final String META_FILE = "pending-meta.json";
    private static final int MAX_PENDING_PER_SESSION = 5000;
    private static final long MAX_PENDING_BYTES_PER_SESSION = 10L * 1024 * 1024;
    private static final long ORPHAN_AGE_MS = 24L * 3600 * 1000;
    /** 防御上限：正常文件受每会话 10MB/5000 条控制，超出视为异常（由 REST 校准兜底） */
    private static final long MAX_EVENTS_FILE_BYTES = 128L * 1024 * 1024;

    public static final class EventRecord {
        public final long seq;
        public final long sessionId;
        public final String json;

        EventRecord(long seq, long sessionId, String json) {
            this.seq = seq;
            this.sessionId = sessionId;
            this.json = json;
        }
    }

    private final File dir;
    private final File eventsFile;
    private final File metaFile;

    /** 未 ACK 事件，按 seq 有序 */
    private final TreeMap<Long, EventRecord> pending = new TreeMap<>();
    /** tombstone：被跳过/丢弃的 seq */
    private final TreeSet<Long> skipped = new TreeSet<>();
    /** 溢出或损坏后需 REST 全量校准的会话 */
    private final Set<Long> restSyncRequired = ConcurrentHashMap.newKeySet();

    private final AtomicLong nextSeq = new AtomicLong(1);
    private volatile long lastAck = 0;
    /** 是否将新事件同步写入磁盘（后台/WebView 离线模式） */
    private volatile boolean persistMode = false;

    /** 每会话当前未 ACK 字节数 */
    private final Map<Long, Long> pendingBytes = new ConcurrentHashMap<>();

    public PendingQueue(Context context, long userId) {
        this.dir = new File(new File(context.getNoBackupFilesDir(), "buffered-events"), String.valueOf(userId));
        this.eventsFile = new File(dir, EVENTS_FILE);
        this.metaFile = new File(dir, META_FILE);
        restore();
    }

    public File getDir() {
        return dir;
    }

    public Set<Long> getRestSyncRequired() {
        return restSyncRequired;
    }

    public long getNextSequence() {
        return nextSeq.get();
    }

    public long getLastAck() {
        return lastAck;
    }

    public synchronized void setPersistMode(boolean persist) {
        if (persist && !this.persistMode) {
            // 切入持久化模式：把此前已在内存但未落盘的未 ACK 事件全部刷盘。
            // 否则切换前收到的 tracked 事件在进程被回收时会丢失，破坏后台可靠恢复语义。
            flushAllToDisk();
        }
        this.persistMode = persist;
    }

    public synchronized boolean isPersistMode() {
        return persistMode;
    }

    /**
     * 分配 sequence 并入队。返回分配的 seq；若事件因未达上限被丢弃返回 -1。
     */
    public synchronized long append(long sessionId, String json) {
        long seq = nextSeq.getAndIncrement();
        EventRecord record = new EventRecord(seq, sessionId, json);
        pending.put(seq, record);
        long bytes = json.length() + 32;
        pendingBytes.merge(sessionId, bytes, Long::sum);

        // 溢出检测：每会话未 ACK 数量或字节超限 → 丢最旧未 ACK 记录并 tombstone
        if (overflow(sessionId, bytes)) {
            dropOldest(sessionId);
        }

        if (persistMode) {
            appendToDisk(record);
        }
        return seq;
    }

    private boolean overflow(long sessionId, long addedBytes) {
        long count = pending.values().stream().filter(r -> r.sessionId == sessionId).count();
        long bytes = pendingBytes.getOrDefault(sessionId, 0L);
        return count > MAX_PENDING_PER_SESSION || bytes > MAX_PENDING_BYTES_PER_SESSION;
    }

    /** 丢弃指定会话最旧的未 ACK 记录，记 tombstone 并标记 REST 校准。 */
    private void dropOldest(long sessionId) {
        Long toDrop = null;
        for (Long seq : pending.keySet()) {
            EventRecord r = pending.get(seq);
            if (r != null && r.sessionId == sessionId) {
                toDrop = seq;
                break;
            }
        }
        if (toDrop != null) {
            skipped.add(toDrop);
            removeRecord(toDrop);
            restSyncRequired.add(sessionId);
            Log.w(TAG, "session " + sessionId + " buffer overflow, drop seq=" + toDrop
                    + " and mark REST calibrate");
        }
        persistMeta();
    }

    /**
     * JS 累计 ACK：确认 lastAck+1..seq 全部已应用（含 skipped）。返回本次推进后的 lastAck。
     */
    public synchronized long ackUpTo(long seq) {
        if (seq > lastAck) {
            lastAck = seq;
            clearPendingUpTo(lastAck);
            skipped.removeIf(s -> s <= lastAck);
        }
        // 水位 = 最大连续「ACK ∪ skipped」：在 lastAck 之上允许 skipped 空洞继续前移
        long watermark = lastAck;
        while (skipped.contains(watermark + 1)) {
            watermark++;
            skipped.remove(watermark);
        }
        if (watermark != lastAck) {
            lastAck = watermark;
            clearPendingUpTo(lastAck);
        }
        persistMeta();
        return lastAck;
    }

    /** 移除 ≤ 上限的全部 pending 记录并同步扣减字节计数。 */
    private void clearPendingUpTo(long upTo) {
        for (Long s : pending.headMap(upTo + 1).keySet().toArray(new Long[0])) {
            removeRecord(s);
        }
    }

    /**
     * 显式标记某 seq 为 skipped（如 WebView 重放中断、校准会话水位前记录丢弃）。
     */
    public synchronized void markSkipped(long seq) {
        skipped.add(seq);
        removeRecord(seq);
    }

    /** 从 pending 移除记录并同步扣减该会话字节计数（溢出判定依赖真实未 ACK 字节数）。 */
    private void removeRecord(long seq) {
        EventRecord r = pending.remove(seq);
        if (r != null) {
            long bytes = r.json.length() + 32;
            pendingBytes.compute(r.sessionId, (k, v) -> (v == null || v <= bytes) ? null : v - bytes);
        }
    }

    /** 回放：返回从 fromSeq（含）开始的未 ACK 记录，按 seq 升序。 */
    public synchronized List<EventRecord> replayFrom(long fromSeq) {
        List<EventRecord> out = new ArrayList<>();
        for (Map.Entry<Long, EventRecord> e : pending.tailMap(fromSeq).entrySet()) {
            if (skipped.contains(e.getKey())) continue;
            out.add(e.getValue());
        }
        return out;
    }

    /** 当前最大未 ACK seq（recovery watermark 用）。 */
    public synchronized long maxPendingSeq() {
        return pending.isEmpty() ? lastAck : pending.lastKey();
    }

    /**
     * compact：重写磁盘文件，仅保留未 ACK 记录（跳过 tombstone 之外的已确认记录）。
     * 失败保留原文件，下次重试。
     */
    public synchronized void compact() {
        if (!eventsFile.exists()) return;
        File tmp = new File(dir, EVENTS_FILE + ".compact.tmp");
        try (RandomAccessFile raf = new RandomAccessFile(tmp, "rw");
             FileChannel ch = raf.getChannel()) {
            raf.setLength(0);
            for (EventRecord r : pending.values()) {
                if (skipped.contains(r.seq)) continue;
                // 必须按 UTF-8 字节写：writeBytes 会丢弃字符高 8 位，中文事件内容会乱码
                raf.write(toLine(r).getBytes("UTF-8"));
            }
            ch.force(true);
            if (!tmp.renameTo(eventsFile)) {
                throw new IOException("rename compact failed");
            }
            Log.i(TAG, "compact done, pending=" + pending.size());
        } catch (IOException e) {
            Log.w(TAG, "compact failed, keep original file: " + e.getMessage());
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
        }
    }

    // ---------------- 持久化 ----------------

    /** 全量重写 events.jsonl 为当前 pending 快照（切换持久化模式 / compact 前置刷盘用）。 */
    private void flushAllToDisk() {
        if (pending.isEmpty()) return;
        File tmp = new File(dir, EVENTS_FILE + ".flush.tmp");
        try {
            FileOutputStream fos = new FileOutputStream(tmp);
            for (EventRecord r : pending.values()) {
                if (skipped.contains(r.seq)) continue;
                fos.write(toLine(r).getBytes("UTF-8"));
            }
            fos.getFD().sync();
            fos.close();
            if (!tmp.renameTo(eventsFile)) {
                throw new IOException("rename flush failed");
            }
            Log.i(TAG, "flushed " + pending.size() + " pending records to disk");
        } catch (IOException e) {
            Log.w(TAG, "flush to disk failed: " + e.getMessage());
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
        }
    }

    private void appendToDisk(EventRecord record) {
        File tmp = new File(dir, EVENTS_FILE + ".append.tmp");
        try {
            // 先复制正式文件旧内容到 tmp，再追加新记录，最后原子 rename。
            // 否则 tmp 只含本次记录，rename 会覆盖丢失此前所有未 ACK 事件。
            if (eventsFile.exists()) {
                Files.copy(eventsFile.toPath(), tmp.toPath(), StandardCopyOption.REPLACE_EXISTING);
            } else if (tmp.exists()) {
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
            }
            FileOutputStream fos = new FileOutputStream(tmp, true);
            fos.write(toLine(record).getBytes("UTF-8"));
            fos.getFD().sync();
            fos.close();
            if (!tmp.renameTo(eventsFile)) {
                throw new IOException("rename append failed");
            }
            Log.d(TAG, "persisted seq=" + record.seq);
        } catch (IOException e) {
            Log.w(TAG, "append to disk failed: " + e.getMessage());
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
        }
    }

    private static String toLine(EventRecord r) {
        return "{\"seq\":" + r.seq + ",\"sessionId\":" + r.sessionId + ",\"data\":" + r.json + "}\n";
    }

    /**
     * 冷启动恢复：
     * 1. 读 meta；
     * 2. 扫描 events.jsonl 最大 seq（损坏行跳过并标记相关会话 REST 校准）；
     * 3. nextSequence = max(meta, 文件最大 seq + 1)；
     * 4. 恢复 lastAck / skipped / restSyncRequired；
     * 5. 不一致（lastAck > 文件最大 seq 等）→ 保守标记 REST 校准；
     * 6. 清理 >24h 孤儿缓冲目录。
     */
    private void restore() {
        try {
            if (dir.exists()) {
                // 清理孤儿目录（无 meta 文件且超过 24h）
                File[] orphans = dir.getParentFile() != null ? dir.getParentFile().listFiles() : null;
                if (orphans != null) {
                    long now = System.currentTimeMillis();
                    for (File f : orphans) {
                        if (f.isDirectory() && f != dir && now - f.lastModified() > ORPHAN_AGE_MS) {
                            deleteRecursively(f);
                            Log.i(TAG, "cleaned orphan buffered dir " + f.getName());
                        }
                    }
                }
            } else if (!dir.mkdirs()) {
                Log.w(TAG, "cannot create buffer dir");
                return;
            }

            long fileMaxSeq = 0;
            if (eventsFile.exists()) {
                fileMaxSeq = scanFileMaxSeq();
            }

            if (metaFile.exists()) {
                String content = readFile(metaFile);
                JSONObject meta = new JSONObject(content);
                long metaNext = meta.optLong("nextSequence", 1);
                lastAck = meta.optLong("lastAckSequence", 0);
                nextSeq.set(Math.max(metaNext, fileMaxSeq + 1));
                JSONArray sk = meta.optJSONArray("skipped");
                if (sk != null) {
                    for (int i = 0; i < sk.length(); i++) skipped.add(sk.getLong(i));
                }
                JSONArray rs = meta.optJSONArray("restSyncRequired");
                if (rs != null) {
                    for (int i = 0; i < rs.length(); i++) restSyncRequired.add(rs.getLong(i));
                }
                // 不一致检测：lastAck 超过文件最大 seq 且文件非空 → 数据丢失，标记校准
                if (fileMaxSeq > 0 && lastAck > fileMaxSeq) {
                    Log.w(TAG, "meta lastAck=" + lastAck + " > fileMaxSeq=" + fileMaxSeq
                            + ", mark restore from disk records");
                }
            } else {
                nextSeq.set(fileMaxSeq + 1);
            }

            // 将磁盘未 ACK 记录加载进内存（lastAck 之后）
            loadDiskRecords(lastAck);
            persistMeta();
            Log.i(TAG, "restored: nextSeq=" + nextSeq.get() + " lastAck=" + lastAck
                    + " skipped=" + skipped.size() + " restSync=" + restSyncRequired.size()
                    + " loaded=" + pending.size());
        } catch (Exception e) {
            Log.w(TAG, "restore failed, conservative: " + e.getMessage());
            // 恢复失败：保守清空并标记当前磁盘数据不可信（由 REST 校准兜底）
            pending.clear();
            skipped.clear();
            pendingBytes.clear();
        }
    }

    private long scanFileMaxSeq() throws IOException {
        long maxSeq = 0;
        List<String> lines = readLines(eventsFile);
        for (String line : lines) {
            if (line.isBlank()) continue;
            try {
                JSONObject obj = new JSONObject(line);
                long seq = obj.getLong("seq");
                if (seq > maxSeq) maxSeq = seq;
            } catch (JSONException e) {
                Log.w(TAG, "corrupt line in events.jsonl, ignored");
            }
        }
        return maxSeq;
    }

    private void loadDiskRecords(long fromSeq) {
        if (!eventsFile.exists()) return;
        try {
            for (String line : readLines(eventsFile)) {
                if (line.isBlank()) continue;
                try {
                    JSONObject obj = new JSONObject(line);
                    long seq = obj.getLong("seq");
                    if (seq <= fromSeq) continue;
                    long sessionId = obj.getLong("sessionId");
                    String data = obj.getJSONObject("data").toString();
                    EventRecord r = new EventRecord(seq, sessionId, data);
                    pending.put(seq, r);
                    pendingBytes.merge(sessionId, (long) (data.length() + 32), Long::sum);
                } catch (JSONException e) {
                    Log.w(TAG, "corrupt record in events.jsonl, skipped");
                }
            }
        } catch (IOException e) {
            Log.w(TAG, "load disk records failed: " + e.getMessage());
        }
    }

    private synchronized void persistMeta() {
        try {
            JSONObject meta = new JSONObject();
            meta.put("nextSequence", nextSeq.get());
            meta.put("lastAckSequence", lastAck);
            meta.put("skipped", new JSONArray(new ArrayList<>(skipped)));
            meta.put("restSyncRequired", new JSONArray(new ArrayList<>(restSyncRequired)));
            File tmp = new File(dir, META_FILE + ".tmp");
            FileOutputStream fos = new FileOutputStream(tmp);
            fos.write(meta.toString().getBytes("UTF-8"));
            fos.getFD().sync();
            fos.close();
            if (!tmp.renameTo(metaFile)) {
                throw new IOException("rename meta failed");
            }
        } catch (Exception e) {
            Log.w(TAG, "persist meta failed: " + e.getMessage());
        }
    }

    // ---------------- 工具 ----------------

    private static String readFile(File f) throws IOException {
        // 按实际长度读取，不截断：事件文件可超过 4MB（单会话上限 10MB），
        // 截断会导致 4MB 后的未 ACK 事件在冷启动恢复时永久缺失
        long len = Math.min(f.length(), MAX_EVENTS_FILE_BYTES);
        byte[] buf = new byte[(int) len];
        try (FileInputStream in = new FileInputStream(f)) {
            int n = 0;
            while (n < buf.length) {
                int r = in.read(buf, n, buf.length - n);
                if (r < 0) break;
                n += r;
            }
            return new String(buf, 0, n, "UTF-8");
        }
    }

    private static List<String> readLines(File f) throws IOException {
        String content = readFile(f);
        List<String> lines = new ArrayList<>();
        Collections.addAll(lines, content.split("\n"));
        return lines;
    }

    private static void deleteRecursively(File f) {
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) {
                for (File c : children) deleteRecursively(c);
            }
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /** 清空全部缓冲（退出登录 / 换账号时调用）。 */
    public synchronized void clearAll() {
        pending.clear();
        skipped.clear();
        restSyncRequired.clear();
        pendingBytes.clear();
        nextSeq.set(1);
        lastAck = 0;
        deleteRecursively(dir);
        if (!dir.mkdirs()) Log.w(TAG, "cannot recreate buffer dir");
        persistMeta();
    }

    /** REST 校准成功会话移除（recovery completeRestSync 用）。 */
    public synchronized void removeRestSyncRequired(Set<Long> sessionIds) {
        boolean changed = false;
        for (Long sid : sessionIds) {
            if (restSyncRequired.remove(sid)) changed = true;
        }
        if (changed) persistMeta();
    }

    /** 该会话是否有未 ACK 事件（tracked 终态判定用）。 */
    public synchronized boolean hasPending(long sessionId) {
        for (EventRecord r : pending.values()) {
            if (r.sessionId == sessionId) return true;
        }
        return false;
    }

    /** 强制持久化全部元数据（recovery 结束时调用）。 */
    public synchronized void persistAll() {
        persistMeta();
    }
}
