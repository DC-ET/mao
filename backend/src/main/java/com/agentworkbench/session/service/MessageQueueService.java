package com.agentworkbench.session.service;

import com.agentworkbench.session.entity.MessageQueue;
import com.agentworkbench.session.mapper.MessageQueueMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.List;

@Slf4j
@Service
@RequiredArgsConstructor
public class MessageQueueService {

    private final MessageQueueMapper messageQueueMapper;

    /**
     * 入队：将消息加入队列末尾
     */
    public MessageQueue enqueue(Long sessionId, Long userId, String content, String images) {
        // 查询当前队列最大 sortOrder
        MessageQueue last = messageQueueMapper.selectOne(
                new LambdaQueryWrapper<MessageQueue>()
                        .eq(MessageQueue::getSessionId, sessionId)
                        .eq(MessageQueue::getStatus, "PENDING")
                        .orderByDesc(MessageQueue::getSortOrder)
                        .last("LIMIT 1"));
        int maxOrder = last != null ? last.getSortOrder() : 0;

        MessageQueue item = new MessageQueue();
        item.setSessionId(sessionId);
        item.setUserId(userId);
        item.setContent(content);
        item.setImages(images);
        item.setSortOrder(maxOrder + 1);
        item.setStatus("PENDING");
        messageQueueMapper.insert(item);
        return item;
    }

    /**
     * 出队：取出并删除队列头部消息
     */
    public MessageQueue dequeue(Long sessionId) {
        MessageQueue head = messageQueueMapper.selectOne(
                new LambdaQueryWrapper<MessageQueue>()
                        .eq(MessageQueue::getSessionId, sessionId)
                        .eq(MessageQueue::getStatus, "PENDING")
                        .orderByAsc(MessageQueue::getSortOrder)
                        .last("LIMIT 1"));
        if (head != null) {
            head.setStatus("DELETED");
            messageQueueMapper.updateById(head);
        }
        return head;
    }

    /**
     * 删除指定队列消息
     */
    public void delete(Long queueId) {
        MessageQueue item = messageQueueMapper.selectById(queueId);
        if (item != null) {
            item.setStatus("DELETED");
            messageQueueMapper.updateById(item);
        }
    }

    /**
     * 重新排序：将指定消息上移/下移（交换 sort_order）
     */
    public void reorder(Long queueId, String direction) {
        MessageQueue current = messageQueueMapper.selectById(queueId);
        if (current == null || !"PENDING".equals(current.getStatus())) return;

        MessageQueue neighbor;
        if ("up".equals(direction)) {
            neighbor = messageQueueMapper.selectOne(
                    new LambdaQueryWrapper<MessageQueue>()
                            .eq(MessageQueue::getSessionId, current.getSessionId())
                            .eq(MessageQueue::getStatus, "PENDING")
                            .lt(MessageQueue::getSortOrder, current.getSortOrder())
                            .orderByDesc(MessageQueue::getSortOrder)
                            .last("LIMIT 1"));
        } else {
            neighbor = messageQueueMapper.selectOne(
                    new LambdaQueryWrapper<MessageQueue>()
                            .eq(MessageQueue::getSessionId, current.getSessionId())
                            .eq(MessageQueue::getStatus, "PENDING")
                            .gt(MessageQueue::getSortOrder, current.getSortOrder())
                            .orderByAsc(MessageQueue::getSortOrder)
                            .last("LIMIT 1"));
        }

        if (neighbor != null) {
            int tempOrder = current.getSortOrder();
            current.setSortOrder(neighbor.getSortOrder());
            neighbor.setSortOrder(tempOrder);
            messageQueueMapper.updateById(current);
            messageQueueMapper.updateById(neighbor);
        }
    }

    /**
     * 查询队列列表（PENDING 状态，按 sort_order 升序）
     */
    public List<MessageQueue> listPending(Long sessionId) {
        return messageQueueMapper.selectList(
                new LambdaQueryWrapper<MessageQueue>()
                        .eq(MessageQueue::getSessionId, sessionId)
                        .eq(MessageQueue::getStatus, "PENDING")
                        .orderByAsc(MessageQueue::getSortOrder));
    }

    /**
     * 根据 ID 查询
     */
    public MessageQueue getById(Long queueId) {
        return messageQueueMapper.selectById(queueId);
    }

    /**
     * 清空队列
     */
    public void clear(Long sessionId) {
        messageQueueMapper.update(null,
                new LambdaUpdateWrapper<MessageQueue>()
                        .eq(MessageQueue::getSessionId, sessionId)
                        .eq(MessageQueue::getStatus, "PENDING")
                        .set(MessageQueue::getStatus, "DELETED"));
    }
}
