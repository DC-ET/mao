package cn.etarch.mao.weixin.service;

import cn.etarch.mao.weixin.config.WeixinBotConfig;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.UUID;

/**
 * 微信入站文件保存：将下载解密的文件写入微信会话工作区。
 * <p>
 * 目录结构：{workspace}/weixin-files/yyyy-MM-dd/{清洗后文件名}
 * <ul>
 *   <li>大小校验：超过 weixin.bot.max-inbound-file-mb 抛出 {@link StorageException}</li>
 *   <li>文件名清洗：取 basename、剔除非法字符、截断长度，防路径穿越</li>
 *   <li>同名处理：追加时间戳后缀，不覆盖已有文件</li>
 * </ul>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class WeixinFileStorageService {

    private static final String BASE_SUBDIR = "weixin-files";
    private static final int MAX_NAME_LENGTH = 120;
    private static final DateTimeFormatter DAY_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd");
    private static final DateTimeFormatter TS_FORMAT = DateTimeFormatter.ofPattern("yyyyMMddHHmmss");

    private final WeixinBotConfig weixinBotConfig;

    /** 文件过大、保存失败等业务错误，消息可直接展示给用户 */
    public static class StorageException extends RuntimeException {
        public StorageException(String message) {
            super(message);
        }
    }

    /**
     * 保存入站文件到会话工作区。
     *
     * @param workspace 会话工作区根路径
     * @param fileName  原始文件名（可为空）
     * @param bytes     文件明文字节
     * @return 保存后的绝对路径
     * @throws StorageException 超限或保存失败（含中文错误信息）
     */
    public Path saveFile(String workspace, String fileName, byte[] bytes) {
        if (bytes == null || bytes.length == 0) {
            throw new StorageException("文件内容为空");
        }
        long maxBytes = (long) weixinBotConfig.getMaxInboundFileMb() * 1024 * 1024;
        if (bytes.length > maxBytes) {
            throw new StorageException("文件超过大小限制（" + weixinBotConfig.getMaxInboundFileMb() + "MB）");
        }

        Path baseDir = resolveBaseDir(workspace);
        String cleaned = sanitizeFileName(fileName);
        try {
            Files.createDirectories(baseDir);
            return writeUnique(baseDir, cleaned, bytes);
        } catch (IOException e) {
            log.error("微信文件保存失败, workspace={}, fileName={}", workspace, cleaned, e);
            throw new StorageException("文件保存失败，请重试");
        }
    }

    /**
     * 计算保存目录：{workspace}/weixin-files/yyyy-MM-dd/，并校验落在工作区内。
     */
    private Path resolveBaseDir(String workspace) {
        Path root = Path.of(workspace != null && !workspace.isBlank() ? workspace : ".")
                .toAbsolutePath().normalize();
        Path dir = root.resolve(BASE_SUBDIR).resolve(LocalDate.now().format(DAY_FORMAT))
                .toAbsolutePath().normalize();
        if (!dir.startsWith(root)) {
            throw new StorageException("非法的工作区路径");
        }
        return dir;
    }

    /**
     * 清洗文件名：取 basename、剔除控制字符与非法字符、截断长度；非法/空结果回退默认名。
     */
    static String sanitizeFileName(String fileName) {
        if (fileName == null || fileName.isBlank()) {
            return "file-" + UUID.randomUUID() + ".bin";
        }
        String name = fileName;
        try {
            // 剔除控制字符（含 NUL），避免 Path 解析异常
            name = name.replaceAll("\\p{Cntrl}", "_");
            // 防路径穿越：Unix 分隔符取 basename（Windows 分隔符 \ 在下一步统一替换）
            if (name.contains("/")) {
                name = Path.of(name).getFileName().toString();
            }
        } catch (InvalidPathException e) {
            return "file-" + UUID.randomUUID() + ".bin";
        }
        // 剔除 Windows 非法字符
        name = name.replaceAll("[\\\\/:*?\"<>|{}@]", "_").trim();
        if (name.isEmpty() || ".".equals(name) || "..".equals(name)) {
            return "file-" + UUID.randomUUID() + ".bin";
        }
        // 长度截断，尽量保留扩展名
        if (name.length() > MAX_NAME_LENGTH) {
            int dot = name.lastIndexOf('.');
            int extLen = dot > 0 ? name.length() - dot : 0;
            if (dot > 0 && extLen <= 20 && extLen < MAX_NAME_LENGTH) {
                name = name.substring(0, MAX_NAME_LENGTH - extLen) + name.substring(dot);
            } else {
                name = name.substring(0, MAX_NAME_LENGTH);
            }
        }
        return name;
    }

    /**
     * 原子写入：CREATE_NEW 保证"选名 + 写入"不分割，避免并发同名消息互相覆盖。
     * 命名顺序：原文件名 → 追加时间戳 → 时间戳+递增序号。
     */
    private Path writeUnique(Path dir, String name, byte[] bytes) throws IOException {
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        String ts = LocalDateTime.now().format(TS_FORMAT);
        int seq = 0;
        while (true) {
            String candidateName = switch (seq) {
                case 0 -> name;
                case 1 -> base + "_" + ts + ext;
                default -> base + "_" + ts + "_" + (seq - 1) + ext;
            };
            Path candidate = dir.resolve(candidateName);
            try {
                return Files.write(candidate, bytes, StandardOpenOption.CREATE_NEW);
            } catch (FileAlreadyExistsException e) {
                // 并发或历史同名：换下一个候选名重试（选名与写入原子，绝不覆盖已有文件）
                seq++;
            }
        }
    }
}
