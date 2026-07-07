package com.agentworkbench.agent.service;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.entity.AgentTag;
import com.agentworkbench.agent.mapper.AgentMapper;
import com.agentworkbench.agent.mapper.AgentTagMapper;
import com.agentworkbench.common.exception.BusinessException;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@SuppressWarnings("unchecked")
class AgentServiceTest {

    private final AgentMapper agentMapper = mock(AgentMapper.class);
    private final AgentTagMapper tagMapper = mock(AgentTagMapper.class);
    private final AgentService service = new AgentService(agentMapper, tagMapper, new ObjectMapper());

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

        Agent created = service.createAgent(7L, "coder", "desc", "prompt", List.of("java", "spring"), List.of("skill-a"));
        assertThat(created.getCreatorId()).isEqualTo(7L);
        assertThat(created.getSkillNames()).contains("skill-a");
        verify(agentMapper).insert(created);
        verify(tagMapper, org.mockito.Mockito.times(2)).insert(any(AgentTag.class));

        Agent updated = service.updateAgent(1L, "new", null, "new prompt", List.of(), List.of("backend"));
        assertThat(updated.getName()).isEqualTo("new");
        assertThat(updated.getSkillNames()).isNull();
        verify(agentMapper).updateById(existing);
        verify(tagMapper).delete(any(QueryWrapper.class));

        service.deleteAgent(1L);
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
