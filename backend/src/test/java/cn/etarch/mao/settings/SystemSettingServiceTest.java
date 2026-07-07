package cn.etarch.mao.settings;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.settings.entity.SystemSetting;
import cn.etarch.mao.settings.mapper.SystemSettingMapper;
import cn.etarch.mao.settings.service.SystemSettingService;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class SystemSettingServiceTest {

    private final SystemSettingMapper mapper = mock(SystemSettingMapper.class);
    private final SystemSettingService service = new SystemSettingService(mapper);

    SystemSettingServiceTest() {
        ReflectionTestUtils.setField(service, "workspaceRoot", "/workspace");
        ReflectionTestUtils.setField(service, "skillsDir", "/skills");
        ReflectionTestUtils.setField(service, "ldapUrl", "");
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
