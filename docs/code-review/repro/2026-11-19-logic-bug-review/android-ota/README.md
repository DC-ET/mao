# BUG-2 验证 harness：android OTA 下载完整性（AppUpdatePlugin.downloadToFile）

对应 `docs/code-review/2026-11-19-logic-bug-review-01.md` 的 BUG-2。

**状态（2026-11-19）：缺陷已修复，本 harness 转正为回归**——期望两个场景均 reject
（修复前的存在性实证输出保留在文末「修复前实测输出」）。

## 被测对象

**仓库原文件**：`android/android/app/src/main/java/cn/etarch/mao/app/AppUpdatePlugin.java`
（编译时以最小桩类替换 Android / Capacitor 运行时）。

## 修复内容（2026-11-19）

`downloadToFile` 改名前增加完整性校验：

- `total > 0 && done != total` → 删 tmp 并抛 `IOException("下载不完整: done/total 字节")`；
- `tmp` 不存在或为空（200 空响应体）→ 删 tmp 并抛 `IOException("下载内容为空")`，
  不再返回上次升级残留的旧包。

## 缺陷摘要（修复前）

`downloadToFile` 拿到 `conn.getContentLengthLong()` 后从未用它做完整性校验：

- **路径 A（优雅截断）**：弱网/代理在传输中途正常关流（TCP FIN），`in.read()` 返回 -1
  而非抛异常，半成品 APK 通过 `tmp.length() > 0` 检查被改名 `mao-update.apk` 并拉起安装，
  `downloadAndInstall` resolve `ok:true` —— 用户只看到系统安装器报「解析包错误」，重试永远失败。
- **路径 B（空响应体 + 陈旧残留）**：`Content-Length: 0` 时 rename 被跳过，但方法仍返回 `apk`；
  此时 `mao-update.apk` 是**上次升级残留的旧包**（从未被清理），被直接拉起安装并
  resolve `ok:true` → 前端 `useVersionCheck.androidInstallUpdate` 置 `appUpdateDownloaded=true`、
  轮询条件 `!appUpdateDownloaded.value` 从此停止检查——更新流程假完成。

正确契约：`total > 0` 时必须校验 `done === total`（否则删 tmp 抛 IOException）；
空产物必须报错而不是返回残留旧包。

## 运行（纯 JDK 17，无 Gradle / 无 JUnit）

```bash
cd docs/code-review/repro/2026-11-19-logic-bug-review/android-ota
javac -encoding UTF-8 -d build $(find stubs -name "*.java") \
  ../../../../../android/android/app/src/main/java/cn/etarch/mao/app/AppUpdatePlugin.java \
  ReproMain.java
java -cp build ReproMain
```

（相对路径以仓库根为基准；Windows Git Bash 下已验证。）

## 修复后实测输出（2026-11-19，JDK 17.0.18 / win32，回归通过）

```
[A] 200 + Content-Length:1000 + 实际仅 500 字节（正常断流）
    call.resolved=false  call.rejectMessage=下载失败: 下载不完整: 500/1000 字节
    mao-update.apk exists=false size=-1（应为 1000 或不存在）
    结论：符合正确契约（reject）

[B] 200 + Content-Length:0（空响应体）+ 预置旧 mao-update.apk（21 字节）
    call.resolved=false  call.rejectMessage=下载失败: 下载内容为空
    被安装的 apk size=21（若为 21 = 旧残留包）
    结论：符合正确契约（reject）

RESULT: 2 项均符合正确契约 —— 修复已生效（修复前本 harness 在缺陷代码上实证 2 项失败，见 README 修复前记录）。
```

## 修复前实测输出（2026-11-19，HEAD 7acf836e，JDK 17.0.18 / win32）

```
[A] 200 + Content-Length:1000 + 实际仅 500 字节（正常断流）
    call.resolved=true  call.rejectMessage=null
    mao-update.apk exists=true size=500（应为 1000 或不存在）
    结论：与正确契约不符 —— 截断的 APK 被改名安装且 resolve ok:true（BUG 实证）

[B] 200 + Content-Length:0（空响应体）+ 预置旧 mao-update.apk（21 字节）
    call.resolved=true  call.rejectMessage=null
    被安装的 apk size=21（若为 21 = 旧残留包）
    结论：与正确契约不符 —— 空响应体未报错，把上次残留的旧 APK 拉起安装并 resolve ok:true（BUG 实证）

RESULT: 2 项与正确契约不符 —— BUG 在当前代码上真实存在（与审查报告一致）。
```

## 桩说明

- `stubs/` 只提供被测文件引用到的最小签名（Context / Activity / PackageManager /
  JSObject / PluginCall / Intent / Uri / Build / Environment / Settings / FileProvider /
  两个 Capacitor 注解 / BuildConfig），无业务逻辑；
  `canRequestPackageInstalls()` 恒 true、`runOnUiThread` 同步执行、`startActivity` no-op。
- 真实 Android 环境下路径 B 的另一分支（无残留包 → `FileProvider.getUriForFile` 对不存在
  文件抛 IllegalArgumentException → reject「拉起安装器失败」）依赖框架行为，桩未模拟；
  本 harness 覆盖的是危害更大的残留包分支。
