package com.agentworkbench.skill.controller;

import com.agentworkbench.common.result.Result;
import com.agentworkbench.skill.entity.SkillEntity;
import com.agentworkbench.skill.service.SkillService;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/v1/skills")
@RequiredArgsConstructor
public class SkillController {

    private final SkillService skillService;

    @GetMapping
    public Result<List<SkillVO>> listSkills() {
        List<SkillVO> voList = skillService.listSkills().stream()
                .map(this::toVO)
                .collect(Collectors.toList());
        return Result.ok(voList);
    }

    @GetMapping("/{id}")
    public Result<SkillVO> getSkill(@PathVariable Long id) {
        return Result.ok(toVO(skillService.getSkill(id)));
    }

    @PostMapping
    public Result<SkillVO> createSkill(
            @AuthenticationPrincipal Long userId,
            @RequestBody CreateSkillRequest request) {
        return Result.ok(toVO(skillService.createSkill(request, userId)));
    }

    @PutMapping("/{id}")
    public Result<SkillVO> updateSkill(@PathVariable Long id, @RequestBody CreateSkillRequest request) {
        return Result.ok(toVO(skillService.updateSkill(id, request)));
    }

    @DeleteMapping("/{id}")
    public Result<Void> deleteSkill(@PathVariable Long id) {
        skillService.deleteSkill(id);
        return Result.ok();
    }

    private SkillVO toVO(SkillEntity entity) {
        SkillVO vo = new SkillVO();
        vo.setId(entity.getId());
        vo.setName(entity.getName());
        vo.setDescription(entity.getDescription());
        vo.setType(entity.getType());
        vo.setStatus(entity.getStatus());
        vo.setCreatedAt(entity.getCreatedAt() != null ? entity.getCreatedAt().toString() : null);
        return vo;
    }

    @Data
    public static class CreateSkillRequest {
        private String name;
        private String description;
        private String type;
        private String inputSchema;
        private String outputSchema;
        private String implClass;
    }

    @Data
    public static class SkillVO {
        private Long id;
        private String name;
        private String description;
        private String type;
        private String status;
        private String createdAt;
    }
}
