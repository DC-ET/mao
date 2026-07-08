package cn.etarch.mao.session.controller;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.common.result.Result;
import cn.etarch.mao.model.entity.LlmModel;
import cn.etarch.mao.model.mapper.LlmModelMapper;
import cn.etarch.mao.session.entity.FileChange;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.user.entity.User;
import cn.etarch.mao.user.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@RestController
@RequestMapping("/v1/admin/sessions")
public class AdminSessionController {

    private final SessionService sessionService;
    private final UserMapper userMapper;
    private final AgentMapper agentMapper;
    private final LlmModelMapper llmModelMapper;

    public AdminSessionController(SessionService sessionService,
                                  UserMapper userMapper,
                                  AgentMapper agentMapper,
                                  LlmModelMapper llmModelMapper) {
        this.sessionService = sessionService;
        this.userMapper = userMapper;
        this.agentMapper = agentMapper;
        this.llmModelMapper = llmModelMapper;
    }

    private static final ObjectMapper objectMapper = new ObjectMapper();

    @GetMapping
    public Result<Map<String, Object>> listSessions(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) Long userId,
            @RequestParam(required = false) Long agentId,
            @RequestParam(required = false) String executionMode,
            @RequestParam(required = false) String phase,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) String status) {

        Page<Session> pageResult = sessionService.listSessionsForAdmin(
                page, size, userId, agentId, executionMode, phase, keyword, status);

        // Batch-load related entities to avoid N+1 queries
        List<Session> records = pageResult.getRecords();
        Map<Long, User> userMap = batchLoadUsers(records);
        Map<Long, Agent> agentMap = batchLoadAgents(records);
        Map<Long, LlmModel> modelMap = batchLoadModels(records);

        List<SessionVO> voList = records.stream()
                .map(s -> toSessionVO(s, userMap, agentMap, modelMap))
                .collect(Collectors.toList());

        return Result.ok(Map.of(
                "records", voList,
                "total", pageResult.getTotal(),
                "page", pageResult.getCurrent(),
                "size", pageResult.getSize()));
    }

    @GetMapping("/{id}")
    public Result<SessionVO> getSession(@PathVariable Long id) {
        Session session = sessionService.getSession(id);
        List<Session> single = List.of(session);
        return Result.ok(toSessionVO(session, batchLoadUsers(single), batchLoadAgents(single), batchLoadModels(single)));
    }

    @GetMapping("/{id}/messages")
    public Result<MessagePageVO> getMessages(
            @PathVariable Long id,
            @RequestParam(defaultValue = "5") int roundLimit,
            @RequestParam(required = false) Long beforeMessageId) {
        SessionService.MessagePage page = sessionService.getMessagesByRounds(id, roundLimit, beforeMessageId);
        List<MessageVO> voList = toMessageVOList(id, page.messages());
        MessagePageVO vo = new MessagePageVO();
        vo.setMessages(voList);
        vo.setHasMore(page.hasMore());
        vo.setNextBeforeMessageId(page.nextBeforeMessageId());
        return Result.ok(vo);
    }

    @GetMapping("/options/users")
    public Result<List<UserOptionVO>> listUserOptions() {
        List<User> users = userMapper.selectList(
                new LambdaQueryWrapper<User>()
                        .select(User::getId, User::getUsername, User::getDisplayName)
                        .orderByAsc(User::getId));
        List<UserOptionVO> options = users.stream().map(u -> {
            UserOptionVO vo = new UserOptionVO();
            vo.setId(u.getId());
            vo.setUsername(u.getUsername());
            vo.setDisplayName(u.getDisplayName());
            return vo;
        }).collect(Collectors.toList());
        return Result.ok(options);
    }

    @GetMapping("/options/agents")
    public Result<List<AgentOptionVO>> listAgentOptions() {
        List<Agent> agents = agentMapper.selectList(
                new LambdaQueryWrapper<Agent>()
                        .select(Agent::getId, Agent::getName)
                        .orderByAsc(Agent::getId));
        List<AgentOptionVO> options = agents.stream().map(a -> {
            AgentOptionVO vo = new AgentOptionVO();
            vo.setId(a.getId());
            vo.setName(a.getName());
            return vo;
        }).collect(Collectors.toList());
        return Result.ok(options);
    }

    // --- VO conversion ---

    private Map<Long, User> batchLoadUsers(List<Session> sessions) {
        Set<Long> ids = sessions.stream().map(Session::getUserId).filter(Objects::nonNull).collect(Collectors.toSet());
        if (ids.isEmpty()) return Map.of();
        return userMapper.selectBatchIds(ids).stream().collect(Collectors.toMap(User::getId, u -> u));
    }

    private Map<Long, Agent> batchLoadAgents(List<Session> sessions) {
        Set<Long> ids = sessions.stream().map(Session::getAgentId).filter(Objects::nonNull).collect(Collectors.toSet());
        if (ids.isEmpty()) return Map.of();
        return agentMapper.selectBatchIds(ids).stream().collect(Collectors.toMap(Agent::getId, a -> a));
    }

    private static final int DEFAULT_CONTEXT_WINDOW_TOKENS = 256000;

    private Map<Long, LlmModel> batchLoadModels(List<Session> sessions) {
        Map<Long, LlmModel> map = new HashMap<>();
        Set<Long> ids = sessions.stream().map(Session::getModelId).filter(Objects::nonNull).collect(Collectors.toSet());
        if (!ids.isEmpty()) {
            llmModelMapper.selectBatchIds(ids).forEach(m -> map.put(m.getId(), m));
        }
        LlmModel defaultModel = llmModelMapper.selectOne(
                new QueryWrapper<LlmModel>().eq("is_default", 1).eq("status", 1));
        if (defaultModel != null) {
            map.put(0L, defaultModel);
        }
        return map;
    }

    private SessionVO toSessionVO(Session session, Map<Long, User> userMap, Map<Long, Agent> agentMap, Map<Long, LlmModel> modelMap) {
        SessionVO vo = new SessionVO();
        vo.setId(session.getId());
        vo.setUserId(session.getUserId());
        vo.setAgentId(session.getAgentId());
        vo.setTitle(session.getTitle());
        vo.setStatus(session.getStatus());
        vo.setExecutionMode(session.getExecutionMode());
        vo.setPhase(session.getPhase() != null ? session.getPhase() : "IDLE");
        vo.setElapsedMs(session.getElapsedMs() != null ? session.getElapsedMs() : 0);
        vo.setProjectKey(session.getProjectKey());
        vo.setWorkspace(session.getWorkspace());
        vo.setContextTokens(session.getContextTokens());
        vo.setCreatedAt(session.getCreatedAt() != null ? session.getCreatedAt().toString() : null);
        vo.setUpdatedAt(session.getUpdatedAt() != null ? session.getUpdatedAt().toString() : null);
        vo.setLastActivityAt(session.getLastActivityAt() != null ? session.getLastActivityAt().toString() : null);

        if (session.getUserId() != null) {
            User user = userMap.get(session.getUserId());
            if (user != null) {
                vo.setUserName(user.getDisplayName() != null ? user.getDisplayName() : user.getUsername());
            }
        }
        if (session.getAgentId() != null) {
            Agent agent = agentMap.get(session.getAgentId());
            if (agent != null) {
                vo.setAgentName(agent.getName());
            }
        }
        LlmModel model = session.getModelId() != null ? modelMap.get(session.getModelId()) : null;
        if (model == null) {
            model = modelMap.get(0L);
        }
        if (model != null) {
            vo.setModelName(model.getName());
            vo.setContextWindowTokens(resolveContextWindowTokens(model));
        } else {
            vo.setContextWindowTokens(DEFAULT_CONTEXT_WINDOW_TOKENS);
        }

        return vo;
    }

    private int resolveContextWindowTokens(LlmModel model) {
        if (model.getContextWindowTokens() != null && model.getContextWindowTokens() > 0) {
            return model.getContextWindowTokens();
        }
        return DEFAULT_CONTEXT_WINDOW_TOKENS;
    }

    private List<MessageVO> toMessageVOList(Long sessionId, List<Message> messages) {
        List<Long> messageIds = messages.stream().map(Message::getId).collect(Collectors.toList());
        Map<Long, List<FileChange>> changesByMsg = sessionService.getFileChangesByMessageIds(sessionId, messageIds);
        return messages.stream().map(msg -> {
            MessageVO vo = toMessageVO(msg);
            List<FileChange> changes = changesByMsg.get(msg.getId());
            if (changes != null && !changes.isEmpty()) {
                vo.setFileChanges(changes.stream().map(this::toFileChangeVO).collect(Collectors.toList()));
            }
            return vo;
        }).collect(Collectors.toList());
    }

    private MessageVO toMessageVO(Message message) {
        MessageVO vo = new MessageVO();
        vo.setId(message.getId());
        vo.setRole(message.getRole());
        vo.setThinkingContent(message.getThinkingContent());
        vo.setToolCallId(message.getToolCallId());
        vo.setToolCalls(message.getToolCalls());
        vo.setMetadata(message.getMetadata());
        vo.setTokenCount(message.getTokenCount());
        vo.setCreatedAt(message.getCreatedAt() != null ? message.getCreatedAt().toString() : null);
        vo.setUpdatedAt(message.getUpdatedAt() != null ? message.getUpdatedAt().toString() : null);

        // Parse multimodal content
        String raw = message.getContent();
        if (raw != null && raw.trim().startsWith("[")) {
            try {
                List<?> parts = objectMapper.readValue(raw, new TypeReference<List<?>>() {});
                StringBuilder textSb = new StringBuilder();
                List<String> images = new ArrayList<>();
                for (Object part : parts) {
                    if (part instanceof java.util.Map<?, ?> map) {
                        Object type = map.get("type");
                        if ("text".equals(type)) {
                            Object text = map.get("text");
                            if (text != null) textSb.append(text);
                        } else if ("image_url".equals(type)) {
                            Object imageUrlObj = map.get("image_url");
                            if (imageUrlObj instanceof java.util.Map<?, ?> imgMap) {
                                Object url = imgMap.get("url");
                                if (url != null) images.add(url.toString());
                            }
                        }
                    }
                }
                vo.setContent(textSb.toString());
                if (!images.isEmpty()) {
                    vo.setImages(images);
                }
            } catch (Exception e) {
                vo.setContent(raw);
            }
        } else {
            vo.setContent(raw);
        }

        return vo;
    }

    private FileChangeVO toFileChangeVO(FileChange fc) {
        FileChangeVO vo = new FileChangeVO();
        vo.setPath(fc.getFilePath());
        vo.setType(fc.getChangeType());
        vo.setLinesAdded(fc.getLinesAdded());
        vo.setLinesDeleted(fc.getLinesDeleted());
        vo.setDiffMode(fc.getDiffMode());
        vo.setBeforeContent(fc.getBeforeContent());
        vo.setAfterContent(fc.getAfterContent());
        vo.setPatchContent(fc.getPatchContent());
        vo.setPatchTruncated(Boolean.TRUE.equals(fc.getPatchTruncated()));
        vo.setDiffUnavailableReason(fc.getDiffUnavailableReason());
        return vo;
    }

    // --- DTOs ---

    @Data
    public static class SessionVO {
        private Long id;
        private Long userId;
        private String userName;
        private Long agentId;
        private String agentName;
        private String title;
        private String status;
        private String executionMode;
        private String phase;
        private String summary;
        private Long elapsedMs;
        private String projectKey;
        private String workspace;
        private Integer contextTokens;
        private Integer contextWindowTokens;
        private String modelName;
        private String createdAt;
        private String updatedAt;
        private String lastActivityAt;
    }

    @Data
    public static class MessagePageVO {
        private List<MessageVO> messages;
        private boolean hasMore;
        private Long nextBeforeMessageId;
    }

    @Data
    public static class MessageVO {
        private Long id;
        private String role;
        private String content;
        private String thinkingContent;
        private List<String> images;
        private String toolCallId;
        private Object toolCalls;
        private String metadata;
        private Integer tokenCount;
        private String createdAt;
        private String updatedAt;
        private List<FileChangeVO> fileChanges;
    }

    @Data
    public static class FileChangeVO {
        private String path;
        private String type;
        private int linesAdded;
        private int linesDeleted;
        private String diffMode;
        private String beforeContent;
        private String afterContent;
        private String patchContent;
        private boolean patchTruncated;
        private String diffUnavailableReason;
    }

    @Data
    public static class UserOptionVO {
        private Long id;
        private String username;
        private String displayName;
    }

    @Data
    public static class AgentOptionVO {
        private Long id;
        private String name;
    }
}
