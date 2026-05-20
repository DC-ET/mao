package com.agentworkbench.harness.skill;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Slf4j
@Component
public class SkillRegistry {

    private final Map<String, Skill> skills = new ConcurrentHashMap<>();

    public SkillRegistry(List<Skill> skillBeans) {
        for (Skill skill : skillBeans) {
            register(skill);
        }
        log.info("SkillRegistry initialized with {} built-in skills: {}", skills.size(), skills.keySet());
    }

    public void register(Skill skill) {
        skills.put(skill.getName(), skill);
        log.info("Registered skill: {}", skill.getName());
    }

    public Skill getSkill(String name) {
        return skills.get(name);
    }

    public List<Skill> getAllSkills() {
        return List.copyOf(skills.values());
    }

    /**
     * Get skills by names (for per-agent filtering)
     */
    public List<Skill> getSkillsByNames(List<String> names) {
        List<Skill> result = new ArrayList<>();
        for (String name : names) {
            Skill skill = skills.get(name);
            if (skill != null) {
                result.add(skill);
            }
        }
        return result;
    }
}
