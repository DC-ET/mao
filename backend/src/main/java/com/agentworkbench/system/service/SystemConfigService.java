package com.agentworkbench.system.service;

import com.agentworkbench.system.entity.SystemConfig;
import com.agentworkbench.system.mapper.SystemConfigMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class SystemConfigService {

    private final SystemConfigMapper systemConfigMapper;

    public Map<String, String> getAllConfigs() {
        List<SystemConfig> configs = systemConfigMapper.selectList(null);
        return configs.stream()
                .collect(Collectors.toMap(SystemConfig::getConfigKey, SystemConfig::getConfigValue));
    }

    public String getConfig(String key) {
        SystemConfig config = systemConfigMapper.selectOne(
                new QueryWrapper<SystemConfig>().eq("config_key", key));
        return config != null ? config.getConfigValue() : null;
    }

    public void updateConfig(String key, String value) {
        SystemConfig config = systemConfigMapper.selectOne(
                new QueryWrapper<SystemConfig>().eq("config_key", key));
        if (config != null) {
            config.setConfigValue(value);
            systemConfigMapper.updateById(config);
        } else {
            config = new SystemConfig();
            config.setConfigKey(key);
            config.setConfigValue(value);
            systemConfigMapper.insert(config);
        }
    }

    public void updateConfigs(Map<String, String> configs) {
        configs.forEach(this::updateConfig);
    }

    public List<SystemConfig> listConfigs() {
        return systemConfigMapper.selectList(null);
    }
}
