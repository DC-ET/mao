package com.agentworkbench.harness.tool.impl;

import com.agentworkbench.harness.todo.entity.SessionTodo;
import com.agentworkbench.harness.todo.mapper.SessionTodoMapper;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.Resource;
import org.springframework.core.io.ResourceLoader;

import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class TaskToolsTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final SessionTodoMapper mapper = mock(SessionTodoMapper.class);
    private final ResourceLoader resourceLoader = mock(ResourceLoader.class);

    @BeforeAll
    static void initMyBatisPlusTableInfo() {
        TableInfoHelper.initTableInfo(new MapperBuilderAssistant(new MybatisConfiguration(), ""), SessionTodo.class);
    }

    @Test
    void createToolCreatesTodosAndLoadsPrompt() throws Exception {
        when(resourceLoader.getResource(any())).thenReturn(resource("create prompt"));
        when(mapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of(todo(1L, "created", "pending")));
        TaskCreateTool tool = new TaskCreateTool(objectMapper, mapper, resourceLoader);

        assertThat(tool.getName()).isEqualTo("task_create");
        assertThat(tool.getDescription()).contains("创建");
        assertThat(tool.getInputSchema()).containsKey("required");
        assertThat(tool.getOutputSchema()).containsEntry("type", "object");
        assertThat(tool.getToolPrompt()).isEqualTo("create prompt");
        assertThat(tool.getToolPrompt()).isEqualTo("create prompt");

        JsonNode result = objectMapper.readTree(tool.execute("""
                {"items":[{"content":"one","description":"desc","active_form":"doing","status":"in_progress"},{"content":"two"}]}
                """, 11L, null));

        assertThat(result.get("message").asText()).contains("2");
        verify(mapper).update(any(), any());
        verify(mapper, org.mockito.Mockito.times(2)).insert(any(SessionTodo.class));
    }

    @Test
    void updateToolUpdatesTodosAndEmitsCompletionHints() throws Exception {
        when(resourceLoader.getResource(any())).thenReturn(resource("update prompt"));
        when(mapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of(
                todo(1L, "implement", "completed"),
                todo(2L, "review", "completed"),
                todo(3L, "ship", "completed")));
        TaskUpdateTool tool = new TaskUpdateTool(objectMapper, mapper, resourceLoader);

        assertThat(tool.getName()).isEqualTo("task_update");
        assertThat(tool.getToolPrompt()).isEqualTo("update prompt");
        JsonNode result = objectMapper.readTree(tool.execute("""
                {"items":[{"id":1,"status":"in_progress","content":"implement"},{"id":1,"status":"completed"}]}
                """, 11L, null));

        assertThat(result.get("summary").asText()).contains("completed");
        assertThat(result.get("hint").asText()).contains("验证");
        verify(mapper, org.mockito.Mockito.atLeast(2)).update(any(), any());

        when(mapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of(todo(1L, "test", "completed")));
        JsonNode verified = objectMapper.readTree(tool.execute("""
                {"items":[{"id":1,"status":"completed"}]}
                """, 11L, null));
        assertThat(verified.get("hint").asText()).contains("下一个").doesNotContain("没有验证");
    }

    @Test
    void deleteAndListToolsReturnProgressAndErrors() throws Exception {
        when(resourceLoader.getResource(any())).thenReturn(resource("prompt"));
        when(mapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of(
                todo(1L, "done", "completed"),
                todo(2L, "doing", "in_progress"),
                todo(3L, "todo", "pending")));

        TaskDeleteTool deleteTool = new TaskDeleteTool(objectMapper, mapper, resourceLoader);
        assertThat(deleteTool.getName()).isEqualTo("task_delete");
        assertThat(deleteTool.getToolPrompt()).isEqualTo("prompt");
        JsonNode deleted = objectMapper.readTree(deleteTool.execute("""
                {"items":[{"id":2},{"id":3}]}
                """, 11L, null));
        assertThat(deleted.get("message").asText()).contains("2");
        verify(mapper, org.mockito.Mockito.times(2)).delete(any(LambdaQueryWrapper.class));

        TaskListTool listTool = new TaskListTool(objectMapper, mapper, resourceLoader);
        assertThat(listTool.getName()).isEqualTo("task_list");
        JsonNode listed = objectMapper.readTree(listTool.execute("{}", 11L, null));
        assertThat(listed.get("progress").asText()).contains("1/3").contains("进行中 1");
        assertThat(listed.get("hint").asText()).contains("in_progress");

        assertThat(objectMapper.readTree(deleteTool.execute("not-json", 11L, null)).get("error").asText()).isNotBlank();
        assertThat(objectMapper.readTree(listTool.execute("{}", 11L, null)).has("todos")).isTrue();
    }

    private static SessionTodo todo(Long id, String content, String status) {
        SessionTodo todo = new SessionTodo();
        todo.setId(id);
        todo.setSessionId(11L);
        todo.setContent(content);
        todo.setStatus(status);
        todo.setSortOrder(id.intValue());
        return todo;
    }

    private static Resource resource(String content) {
        return new ByteArrayResource(content.getBytes(StandardCharsets.UTF_8));
    }
}
