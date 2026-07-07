package com.agentworkbench.session.service;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.agentworkbench.session.entity.MessageQueue;
import com.agentworkbench.session.mapper.MessageQueueMapper;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class MessageQueueServiceTest {

    private final MessageQueueMapper mapper = mock(MessageQueueMapper.class);
    private final MessageQueueService service = new MessageQueueService(mapper);

    @Test
    void enqueueAppendsAfterLastPendingItem() {
        MessageQueue last = queue(1L, 10L, 4, "PENDING");
        when(mapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(last);

        MessageQueue item = service.enqueue(10L, 20L, "hello", "[img]");

        assertThat(item.getSessionId()).isEqualTo(10L);
        assertThat(item.getUserId()).isEqualTo(20L);
        assertThat(item.getContent()).isEqualTo("hello");
        assertThat(item.getImages()).isEqualTo("[img]");
        assertThat(item.getSortOrder()).isEqualTo(5);
        assertThat(item.getStatus()).isEqualTo("PENDING");
        verify(mapper).insert(item);
    }

    @Test
    void dequeueMarksHeadDeletedWhenPresent() {
        MessageQueue head = queue(2L, 10L, 1, "PENDING");
        when(mapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(head);

        MessageQueue result = service.dequeue(10L);

        assertThat(result).isSameAs(head);
        assertThat(head.getStatus()).isEqualTo("DELETED");
        verify(mapper).updateById(head);
    }

    @Test
    void deleteIgnoresMissingItemAndDeletesExistingItem() {
        when(mapper.selectById(1L)).thenReturn(null);
        service.delete(1L);
        verify(mapper, never()).updateById(any());

        MessageQueue item = queue(2L, 10L, 1, "PENDING");
        when(mapper.selectById(2L)).thenReturn(item);
        service.delete(2L);
        assertThat(item.getStatus()).isEqualTo("DELETED");
        verify(mapper).updateById(item);
    }

    @Test
    void reorderSwapsSortOrderWithNeighbor() {
        MessageQueue current = queue(3L, 10L, 2, "PENDING");
        MessageQueue neighbor = queue(4L, 10L, 1, "PENDING");
        when(mapper.selectById(3L)).thenReturn(current);
        when(mapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(neighbor);

        service.reorder(3L, "up");

        assertThat(current.getSortOrder()).isEqualTo(1);
        assertThat(neighbor.getSortOrder()).isEqualTo(2);
        verify(mapper).updateById(current);
        verify(mapper).updateById(neighbor);
    }

    @Test
    void reorderIgnoresMissingDeletedOrEdgeItem() {
        when(mapper.selectById(10L)).thenReturn(null);
        service.reorder(10L, "down");

        MessageQueue deleted = queue(11L, 10L, 2, "DELETED");
        when(mapper.selectById(11L)).thenReturn(deleted);
        service.reorder(11L, "down");

        MessageQueue current = queue(12L, 10L, 2, "PENDING");
        when(mapper.selectById(12L)).thenReturn(current);
        when(mapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(null);
        service.reorder(12L, "down");

        verify(mapper, never()).updateById(any());
    }

    @Test
    void listGetAndClearDelegateToMapper() {
        List<MessageQueue> rows = List.of(queue(5L, 10L, 1, "PENDING"));
        MessageQueue byId = queue(6L, 10L, 2, "PENDING");
        when(mapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(rows);
        when(mapper.selectById(6L)).thenReturn(byId);

        assertThat(service.listPending(10L)).isEqualTo(rows);
        assertThat(service.getById(6L)).isSameAs(byId);
        TableInfoHelper.initTableInfo(new MapperBuilderAssistant(new MybatisConfiguration(), ""), MessageQueue.class);
        service.clear(10L);

        verify(mapper).update(eq(null), any(LambdaUpdateWrapper.class));
    }

    private static MessageQueue queue(Long id, Long sessionId, int order, String status) {
        MessageQueue item = new MessageQueue();
        item.setId(id);
        item.setSessionId(sessionId);
        item.setSortOrder(order);
        item.setStatus(status);
        return item;
    }
}
