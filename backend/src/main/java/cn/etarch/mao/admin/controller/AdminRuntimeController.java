package cn.etarch.mao.admin.controller;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.Result;
import cn.etarch.mao.session.controller.AdminSessionController;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.user.entity.User;
import cn.etarch.mao.user.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import io.swagger.v3.oas.annotations.Hidden;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

@Slf4j
@RestController
@RequestMapping("/v1/admin/runtime")
@RequiredArgsConstructor
public class AdminRuntimeController {

    private static final String ADMIN_USERNAME = "admin";

    private final AdminSessionController adminSessionController;
    private final UserMapper userMapper;
    private final PasswordEncoder passwordEncoder;

    /** 后端重启脚本绝对路径（生产默认 /root/soft/mao/backend/restart.sh）。 */
    @Value("${app.runtime.restart-script:/root/soft/mao/backend/restart.sh}")
    private String restartScript;

    private final AtomicBoolean restarting = new AtomicBoolean(false);

    @GetMapping("/sessions")
    public Result<Map<String, Object>> listRuntimeSessions(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) Long userId,
            @RequestParam(required = false) Long agentId,
            @RequestParam(required = false) String executionMode,
            @RequestParam(required = false) String phase,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) String status) {
        String runtimePhase = (phase == null || phase.isBlank())
                ? "RUNNING,RESUMING,WAITING_APPROVAL,FAILED,CANCELLED"
                : phase;
        return adminSessionController.listSessions(
                page, size, userId, agentId, executionMode, runtimePhase, keyword, status);
    }

    @GetMapping("/stale-threshold")
    public Result<Map<String, Object>> staleThreshold() {
        return Result.ok(Map.of("staleMinutes", SessionService.getStaleMinutes()));
    }

    /**
     * 内部运维：校验 key 后异步执行重启脚本并立即返回。
     */
    @Hidden
    @GetMapping("/restart")
    public Result<Map<String, Object>> restart(@RequestParam("key") String key) {
        assertAdminPasswordKey(key);

        Path script = Path.of(restartScript).toAbsolutePath().normalize();
        if (!Files.isRegularFile(script)) {
            throw new BusinessException(500, "重启脚本不存在: " + script);
        }
        if (!Files.isExecutable(script)) {
            throw new BusinessException(500, "重启脚本不可执行: " + script);
        }
        if (!restarting.compareAndSet(false, true)) {
            throw new BusinessException(409, "重启已在进行中");
        }

        log.warn("Backend restart triggered via key auth, script={}", script);

        Thread starter = new Thread(() -> {
            try {
                // 稍延迟，确保本接口响应先写出再被脚本 stop
                Thread.sleep(800);
                // setsid：脱离当前会话，避免 JVM 被 kill 时脚本收到 SIGHUP
                ProcessBuilder pb = new ProcessBuilder("setsid", script.toString());
                pb.redirectOutput(ProcessBuilder.Redirect.appendTo(Path.of("/tmp/mao-backend-restart.log").toFile()));
                pb.redirectError(ProcessBuilder.Redirect.appendTo(Path.of("/tmp/mao-backend-restart.log").toFile()));
                pb.redirectInput(ProcessBuilder.Redirect.INHERIT);
                pb.start();
                log.info("Restart script launched: {}", script);
            } catch (Exception e) {
                restarting.set(false);
                log.error("Failed to launch restart script {}: {}", script, e.getMessage(), e);
            }
        }, "backend-restart-launcher");
        starter.setDaemon(true);
        starter.start();

        return Result.ok(Map.of(
                "accepted", true,
                "message", "重启指令已接受，服务即将重启",
                "script", script.toString()));
    }

    private void assertAdminPasswordKey(String key) {
        if (key == null || key.isBlank()) {
            throw new BusinessException(401, "key 无效");
        }
        User admin = userMapper.selectOne(new QueryWrapper<User>().eq("username", ADMIN_USERNAME));
        if (admin == null || admin.getPasswordHash() == null || admin.getPasswordHash().isBlank()) {
            throw new BusinessException(500, "admin 用户不存在或未设置本地密码");
        }
        if (admin.getStatus() != null && admin.getStatus() == 0) {
            throw new BusinessException(403, "admin 账号已禁用");
        }
        if (!passwordEncoder.matches(key, admin.getPasswordHash())) {
            throw new BusinessException(401, "key 无效");
        }
    }
}
