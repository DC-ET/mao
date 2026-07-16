package cn.etarch.mao.settings.service;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.model.entity.LlmModel;
import cn.etarch.mao.model.mapper.LlmModelMapper;
import cn.etarch.mao.settings.entity.SystemSetting;
import cn.etarch.mao.settings.mapper.SystemSettingMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.List;
import java.util.Map;

@Service
@RequiredArgsConstructor
public class SystemSettingService {

    public static final String WEIXIN_AGENT_ID_KEY = "weixin.agentId";
    public static final String WEIXIN_MODEL_ID_KEY = "weixin.modelId";

    private final SystemSettingMapper systemSettingMapper;
    private final AgentMapper agentMapper;
    private final LlmModelMapper llmModelMapper;

    @Value("${app.harness.workspace-root:/opt/mao/data/workspace}")
    private String workspaceRoot;

    @Value("${app.harness.skills-dir:/opt/mao/data/skills}")
    private String skillsDir;

    @Value("${ldap.enabled:false}")
    private boolean ldapEnabled;

    @Value("${ldap.url:}")
    private String ldapUrl;

    @Value("${feishu.enabled:false}")
    private boolean feishuEnabled;

    @Value("${feishu.app-id:}")
    private String feishuAppId;

    public List<SystemSetting> list(String category) {
        LambdaQueryWrapper<SystemSetting> qw = new LambdaQueryWrapper<>();
        if (StringUtils.hasText(category)) {
            qw.eq(SystemSetting::getCategory, category);
        }
        qw.orderByAsc(SystemSetting::getCategory).orderByAsc(SystemSetting::getId);
        List<SystemSetting> settings = systemSettingMapper.selectList(qw);
        applyRuntimeValues(settings);
        return settings;
    }

    public String getValue(String key) {
        SystemSetting setting = systemSettingMapper.selectOne(
                new LambdaQueryWrapper<SystemSetting>().eq(SystemSetting::getSettingKey, key));
        return setting != null ? setting.getValue() : null;
    }

    public SystemSetting update(String key, String value) {
        SystemSetting setting = systemSettingMapper.selectOne(
                new LambdaQueryWrapper<SystemSetting>().eq(SystemSetting::getSettingKey, key));
        if (setting == null) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "系统配置不存在");
        }
        if (setting.getEditable() == null || setting.getEditable() != 1) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "该配置仅展示，不支持在后台修改");
        }
        validateValue(key, value);
        setting.setValue(value != null ? value : "");
        systemSettingMapper.updateById(setting);
        return setting;
    }

    private void applyRuntimeValues(List<SystemSetting> settings) {
        Map<String, String> runtimeValues = Map.of(
                "workspace.root", workspaceRoot,
                "skills.dir", skillsDir,
                "auth.ldap.enabled", String.valueOf(ldapEnabled && StringUtils.hasText(ldapUrl)),
                "auth.feishu.enabled", String.valueOf(feishuEnabled && StringUtils.hasText(feishuAppId) && !"1234567890".equals(feishuAppId))
        );
        for (SystemSetting setting : settings) {
            if (runtimeValues.containsKey(setting.getSettingKey())) {
                setting.setValue(runtimeValues.get(setting.getSettingKey()));
            }
        }
    }

    private void validateValue(String key, String value) {
        if (WEIXIN_AGENT_ID_KEY.equals(key)) {
            if (!StringUtils.hasText(value)) {
                return;
            }
            try {
                Long agentId = Long.parseLong(value.trim());
                Agent agent = agentMapper.selectById(agentId);
                if (agent == null) {
                    throw new BusinessException(ErrorCode.PARAM_INVALID, "指定的 Agent 不存在");
                }
            } catch (NumberFormatException e) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "微信智能体配置必须是有效的 Agent ID");
            }
            return;
        }
        if (WEIXIN_MODEL_ID_KEY.equals(key)) {
            if (!StringUtils.hasText(value)) {
                return;
            }
            try {
                Long modelId = Long.parseLong(value.trim());
                LlmModel model = llmModelMapper.selectById(modelId);
                if (model == null) {
                    throw new BusinessException(ErrorCode.PARAM_INVALID, "指定的模型不存在");
                }
            } catch (NumberFormatException e) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "微信模型配置必须是有效的模型 ID");
            }
            return;
        }
        if (!StringUtils.hasText(value)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "配置值不能为空");
        }
        if (key.endsWith("Days") || key.endsWith("Size") || key.endsWith("SizeMb") || key.equals("ui.defaultPageSize")) {
            try {
                int number = Integer.parseInt(value);
                if (number <= 0) {
                    throw new NumberFormatException("must be positive");
                }
            } catch (NumberFormatException e) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "配置值必须为正整数");
            }
        }
        if (key.endsWith("enabled") && !("true".equalsIgnoreCase(value) || "false".equalsIgnoreCase(value))) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "开关值必须为 true 或 false");
        }
    }
}
