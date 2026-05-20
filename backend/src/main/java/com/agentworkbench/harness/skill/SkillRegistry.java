package com.agentworkbench.harness.skill;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Skill 注册中心
 * 管理所有可用的内置 Skills
 */
@Slf4j
@Component
public class SkillRegistry {

    private final Map<String, Skill> skills = new ConcurrentHashMap<>();

    /**
     * 注册 Skill
     */
    public void register(Skill skill) {
        skills.put(skill.getName(), skill);
        log.info("Registered skill: {}", skill.getName());
    }

    /**
     * 获取 Skill
     */
    public Skill getSkill(String name) {
        return skills.get(name);
    }

    /**
     * 获取所有已注册的 Skill
     */
    public List<Skill> getAllSkills() {
        return List.copyOf(skills.values());
    }
}
