package cn.etarch.mao.agent.service;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.agent.entity.AgentTag;
import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.agent.mapper.AgentTagMapper;
import cn.etarch.mao.common.exception.BusinessException;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@SuppressWarnings("unchecked")
class AgentServiceTest {

    private final AgentMapper agentMapper = mock(AgentMapper.class);
    private final AgentTagMapper tagMapper = mock(AgentTagMapper.class);
    private final AgentExperienceService experienceService = mock(AgentExperienceService.class);
    private final AgentService service = new AgentService(
            agentMapper, tagMapper, experienceService, new ObjectMapper());

    @Test
    void listsGetsCreatesUpdatesDeletesAndLoadsTags() {
        Agent existing = agent(1L, "old");
        AgentTag tag = new AgentTag();
        tag.setAgentId(1L);
        tag.setTag("java");
        when(agentMapper.selectList(any(QueryWrapper.class))).thenReturn(List.of(existing));
        when(agentMapper.selectById(1L)).thenReturn(existing);
        when(tagMapper.selectList(any(QueryWrapper.class))).thenReturn(List.of(tag));

        assertThat(service.listAgents(7L, "old")).containsExactly(existing);
        assertThat(service.getAgent(1L)).isSameAs(existing);
        assertThat(service.getAgentTags(1L)).containsExactly(tag);

        List<AgentExperienceService.ExperienceInput> experiences = List.of(
                AgentExperienceService.ExperienceInput.of(null, "tip", 0, true));
        Agent created = service.createAgent(
                7L, "coder", "desc", "prompt",
                List.of("java", "spring"), List.of("skill-a"), experiences);
        assertThat(created.getCreatorId()).isEqualTo(7L);
        assertThat(created.getSkillNames()).contains("skill-a");
        verify(agentMapper).insert(created);
        verify(tagMapper, org.mockito.Mockito.times(2)).insert(any(AgentTag.class));
        verify(experienceService).syncExperiences(eq(created.getId()), eq(experiences));

        Agent updated = service.updateAgent(
                1L, "new", null, "new prompt", List.of(), List.of("backend"), experiences);
        assertThat(updated.getName()).isEqualTo("new");
        assertThat(updated.getSkillNames()).isNull();
        verify(agentMapper).updateById(existing);
        verify(tagMapper).delete(any(QueryWrapper.class));
        verify(experienceService).syncExperiences(1L, experiences);

        service.deleteAgent(1L);
        verify(experienceService).deleteByAgentId(1L);
        verify(agentMapper).deleteById(1L);
    }

    @Test
    void getAgentThrowsWhenMissing() {
        when(agentMapper.selectById(404L)).thenReturn(null);
        assertThatThrownBy(() -> service.getAgent(404L)).isInstanceOf(BusinessException.class);
    }

    private static Agent agent(Long id, String name) {
        Agent agent = new Agent();
        agent.setId(id);
        agent.setName(name);
        return agent;
    }
}
