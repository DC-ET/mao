import cn.etarch.mao.app.AppUpdatePlugin;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.sun.net.httpserver.HttpServer;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 2026-11-19 逻辑 BUG 审查 · BUG-2 验证 harness（android OTA 下载完整性）。
 *
 * 被测对象：仓库原文件 android/android/app/src/main/java/cn/etarch/mao/app/AppUpdatePlugin.java
 * （仅以桩类替换 Android / Capacitor 运行时）。
 *
 * 历史：先作为存在性验证，在缺陷代码上实证 2 项失败（输出见 README 修复前记录）；
 * 2026-11-19 修复 downloadToFile 后转正为回归 harness——期望两个场景均 reject。
 *
 * 正确契约（downloadToFile 注释「下载到临时文件，完成后改名」+ 完整性校验）：
 *   - 传输中途正常断流（EOF 早于 Content-Length）必须报错删除半成品，不得改名安装；
 *   - 200 空响应体（Content-Length: 0）必须报错，不得把上次升级残留的旧 mao-update.apk
 *     拉起安装并 resolve ok:true（前端 useVersionCheck 据此置 appUpdateDownloaded=true、
 *     停止后续轮询——更新流程假完成）。
 *
 * 运行：见 README.md（javac + java，纯 JDK，无 JUnit）。
 */
public final class ReproMain {

    private static int failures = 0;

    public static void main(String[] args) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/truncated", exchange -> {
            byte[] half = new byte[500];
            exchange.getResponseHeaders().set("Content-Type", "application/vnd.android.package-archive");
            // 声明 1000 字节，只写 500 后直接关流：模拟弱网/代理在传输中途正常断流（TCP FIN）
            exchange.sendResponseHeaders(200, 1000);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(half);
            }
        });
        server.createContext("/empty", exchange -> {
            exchange.sendResponseHeaders(200, 0); // Content-Length: 0，无响应体
            exchange.close();
        });
        server.start();
        int port = server.getAddress().getPort();
        System.out.println("HTTP server on 127.0.0.1:" + port);

        try {
            testGracefulTruncation(port);
            testEmptyBodyInstallsStaleApk(port);
        } finally {
            server.stop(0);
        }

        if (failures > 0) {
            System.out.println("\nRESULT: " + failures + " 项与正确契约不符 —— BUG-2 缺陷回归（审查报告 docs/code-review/2026-11-19-logic-bug-review-01.md）。");
            System.exit(1);
        }
        System.out.println("\nRESULT: 2 项均符合正确契约 —— 修复已生效（修复前本 harness 在缺陷代码上实证 2 项失败，见 README 修复前记录）。");
        System.exit(0);
    }

    /** 用例 A：优雅截断。期望 reject；缺陷行为 = resolve ok:true + 半成品被改名安装。 */
    private static void testGracefulTruncation(int port) throws Exception {
        AppUpdatePlugin plugin = new AppUpdatePlugin();
        File downloads = Files.createTempDirectory("mao-ota-a").toFile();
        plugin.setExternalFilesDir(downloads);
        PluginCall call = new PluginCall();
        call.params.put("url", "http://127.0.0.1:" + port + "/truncated");
        plugin.downloadAndInstall(call);
        awaitSettled(call, "A");

        File apk = new File(downloads, "mao-updates/mao-update.apk");
        boolean truncatedInstalled = call.resolved && apk.isFile() && apk.length() == 500;

        System.out.println("\n[A] 200 + Content-Length:1000 + 实际仅 500 字节（正常断流）");
        System.out.println("    call.resolved=" + call.resolved + "  call.rejectMessage=" + call.rejectMessage);
        System.out.println("    mao-update.apk exists=" + apk.isFile() + " size=" + (apk.isFile() ? apk.length() : -1) + "（应为 1000 或不存在）");
        if (truncatedInstalled) {
            System.out.println("    结论：与正确契约不符 —— 截断的 APK 被改名安装且 resolve ok:true（缺陷回归）");
            failures++;
        } else if (call.rejected) {
            System.out.println("    结论：符合正确契约（reject）");
        } else {
            System.out.println("    结论：与预期两侧都不符（resolved=false rejected=false）——检查测试环境");
            failures++;
        }
    }

    /** 用例 B：200 空响应体 + 上次残留的旧 mao-update.apk。期望 reject；缺陷行为 = 安装旧包并 ok:true。 */
    private static void testEmptyBodyInstallsStaleApk(int port) throws Exception {
        AppUpdatePlugin plugin = new AppUpdatePlugin();
        File downloads = Files.createTempDirectory("mao-ota-b").toFile();
        plugin.setExternalFilesDir(downloads);
        File apk = new File(downloads, "mao-updates/mao-update.apk");
        // 模拟「上次升级下载后残留」：旧版本 APK 从未被清理（downloadToFile 仅在成功改名前删除）
        writeBytes(apk, "STALE-OLD-APK-PAYLOAD".getBytes(StandardCharsets.UTF_8));

        PluginCall call = new PluginCall();
        call.params.put("url", "http://127.0.0.1:" + port + "/empty");
        plugin.downloadAndInstall(call);
        awaitSettled(call, "B");

        boolean staleInstalled = call.resolved && apk.isFile() && apk.length() == 21;

        System.out.println("\n[B] 200 + Content-Length:0（空响应体）+ 预置旧 mao-update.apk（21 字节）");
        System.out.println("    call.resolved=" + call.resolved + "  call.rejectMessage=" + call.rejectMessage);
        System.out.println("    被安装的 apk size=" + (apk.isFile() ? apk.length() : -1) + "（若为 21 = 旧残留包）");
        if (staleInstalled) {
            System.out.println("    结论：与正确契约不符 —— 空响应体未报错，把上次残留的旧 APK 拉起安装并 resolve ok:true（缺陷回归）");
            failures++;
        } else if (call.rejected) {
            System.out.println("    结论：符合正确契约（reject）");
        } else {
            System.out.println("    结论：与预期两侧都不符（resolved=false rejected=false）——检查测试环境");
            failures++;
        }
    }

    private static void awaitSettled(PluginCall call, String tag) throws InterruptedException {
        AtomicReference<String> state = new AtomicReference<>(null);
        long deadline = System.currentTimeMillis() + 30_000;
        while (System.currentTimeMillis() < deadline) {
            if (call.resolved) state.set("resolved");
            if (call.rejected) state.set("rejected");
            if (state.get() != null) {
                System.out.println("    [" + tag + "] call settled: " + state.get());
                return;
            }
            Thread.sleep(50);
        }
        System.out.println("    [" + tag + "] 30s 内未收敛（resolved=false rejected=false）");
    }

    private static void writeBytes(File file, byte[] bytes) throws IOException {
        file.getParentFile().mkdirs();
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(bytes);
        }
    }
}
