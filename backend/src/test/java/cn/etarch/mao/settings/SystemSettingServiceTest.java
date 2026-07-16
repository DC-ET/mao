package cn.etarch.mao.settings;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.settings.entity.SystemSetting;
import cn.etarch.mao.settings.mapper.SystemSettingMapper;
import cn.etarch.mao.settings.service.SystemSettingService;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class SystemSettingServiceTest {

    private final SystemSettingMapper mapper = mock(SystemSettingMapper.class);
    private final AgentMapper agentMapper = mock(AgentMapper.class);
    private final SystemSettingService service = new SystemSettingService(mapper, agentMapper);

    SystemSettingServiceTest() {
        ReflectionTestUtils.setField(service, "workspaceRoot", "/workspace");
        ReflectionTestUtils.setField(service, "skillsDir", "/skills");
        ReflectionTestUtils.setField(service, "ldapEnabled", false);
        ReflectionTestUtils.setField(service, "ldapUrl", "");
        ReflectionTestUtils.setField(service, "feishuEnabled", false);
        ReflectionTestUtils.setField(service, "feishuAppId", "");
    }

    @Test
    void updateRejectsReadonlySetting() {
        SystemSetting setting = setting("workspace.root", "运行环境", 0);
        when(mapper.selectOne(any())).thenReturn(setting);

        assertThatThrownBy(() -> service.update("workspace.root", "/tmp/workspace"))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("仅展示");
    }

    @Test
    void updateValidatesPositiveIntegerSettings() {
        SystemSetting setting = setting("audit.retentionDays", "审计", 1);
        when(mapper.selectOne(any())).thenReturn(setting);

        assertThatThrownBy(() -> service.update("audit.retentionDays", "0"))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("正整数");
    }

    @Test
    void updatePersistsEditableSetting() {
        SystemSetting setting = setting("ui.defaultPageSize", "界面", 1);
        when(mapper.selectOne(any())).thenReturn(setting);

        SystemSetting updated = service.update("ui.defaultPageSize", "50");

        assertThat(updated.getValue()).isEqualTo("50");
        verify(mapper).updateById(setting);
    }

    @Test
    void updateAllowsEmptyWeixinAgentId() {
        SystemSetting setting = setting(SystemSettingService.WEIXIN_AGENT_ID_KEY, "微信", 1);
        when(mapper.selectOne(any())).thenReturn(setting);

        SystemSetting updated = service.update(SystemSettingService.WEIXIN_AGENT_ID_KEY, "");

        assertThat(updated.getValue()).isEqualTo("");
        verify(mapper).updateById(setting);
    }

    @Test
    void updateValidatesWeixinAgentExists() {
        SystemSetting setting = setting(SystemSettingService.WEIXIN_AGENT_ID_KEY, "微信", 1);
        when(mapper.selectOne(any())).thenReturn(setting);
        when(agentMapper.selectById(9L)).thenReturn(null);

        assertThatThrownBy(() -> service.update(SystemSettingService.WEIXIN_AGENT_ID_KEY, "9"))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("Agent 不存在");
    }

    @Test
    void updateAcceptsValidWeixinAgentId() {
        SystemSetting setting = setting(SystemSettingService.WEIXIN_AGENT_ID_KEY, "微信", 1);
        when(mapper.selectOne(any())).thenReturn(setting);
        Agent agent = new Agent();
        agent.setId(9L);
        when(agentMapper.selectById(9L)).thenReturn(agent);

        SystemSetting updated = service.update(SystemSettingService.WEIXIN_AGENT_ID_KEY, "9");

        assertThat(updated.getValue()).isEqualTo("9");
    }

    @Test
    void listShowsLdapEnabledOnlyWhenSwitchAndUrlArePresent() {
        SystemSetting ldapSetting = setting("auth.ldap.enabled", "认证", 0);
        when(mapper.selectList(any())).thenReturn(List.of(ldapSetting));

        ReflectionTestUtils.setField(service, "ldapEnabled", true);
        ReflectionTestUtils.setField(service, "ldapUrl", "");
        assertThat(service.list(null).get(0).getValue()).isEqualTo("false");

        ReflectionTestUtils.setField(service, "ldapUrl", "ldap://example.test:389");
        assertThat(service.list(null).get(0).getValue()).isEqualTo("true");
    }

    @Test
    void listShowsFeishuEnabledOnlyWhenSwitchAndAppIdArePresent() {
        SystemSetting feishuSetting = setting("auth.feishu.enabled", "认证", 0);
        when(mapper.selectList(any())).thenReturn(List.of(feishuSetting));

        ReflectionTestUtils.setField(service, "feishuEnabled", true);
        ReflectionTestUtils.setField(service, "feishuAppId", "");
        assertThat(service.list(null).get(0).getValue()).isEqualTo("false");

        ReflectionTestUtils.setField(service, "feishuAppId", "cli_xxx");
        assertThat(service.list(null).get(0).getValue()).isEqualTo("true");
    }

    private SystemSetting setting(String key, String category, int editable) {
        SystemSetting setting = new SystemSetting();
        setting.setId(1L);
        setting.setSettingKey(key);
        setting.setCategory(category);
        setting.setValue("20");
        setting.setEditable(editable);
        return setting;
    }
}
