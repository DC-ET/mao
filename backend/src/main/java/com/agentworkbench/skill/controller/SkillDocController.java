package com.agentworkbench.skill.controller;

import com.agentworkbench.common.result.Result;
import com.agentworkbench.harness.skill.SkillDocument;
import com.agentworkbench.harness.skill.SkillLoader;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.stream.Collectors;

/**
 * REST API for Anthropic-style Skill knowledge documents (SKILL.md files).
 */
@RestController
@RequestMapping("/v1/skill-docs")
@RequiredArgsConstructor
public class SkillDocController {

    private final SkillLoader skillLoader;

    @GetMapping
    public Result<List<SkillDocVO>> listSkillDocs() {
        List<SkillDocVO> voList = skillLoader.getAllDocuments().stream()
                .map(this::toVO)
                .collect(Collectors.toList());
        return Result.ok(voList);
    }

    @GetMapping("/{name}")
    public Result<SkillDocDetailVO> getSkillDoc(@PathVariable String name) {
        SkillDocument doc = skillLoader.getAllDocuments().stream()
                .filter(d -> d.getName().equals(name))
                .findFirst()
                .orElse(null);
        if (doc == null) {
            return Result.fail(404, "Skill not found: " + name);
        }
        SkillDocDetailVO vo = new SkillDocDetailVO();
        vo.setName(doc.getName());
        vo.setDescription(doc.getDescription());
        vo.setBody(doc.getBody());
        vo.setFolderPath(doc.getFolderPath());
        vo.setFilePath(doc.getFilePath());
        return Result.ok(vo);
    }

    private SkillDocVO toVO(SkillDocument doc) {
        SkillDocVO vo = new SkillDocVO();
        vo.setName(doc.getName());
        vo.setDescription(doc.getDescription());
        vo.setFolderPath(doc.getFolderPath());
        vo.setFilePath(doc.getFilePath());
        return vo;
    }

    @Data
    public static class SkillDocVO {
        private String name;
        private String description;
        private String folderPath;
        private String filePath;
    }

    @Data
    public static class SkillDocDetailVO {
        private String name;
        private String description;
        private String body;
        private String folderPath;
        private String filePath;
    }
}
