package cn.etarch.mao.harness.tool;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class ToolRegistryTest {

    @Test
    void registersAndLooksUpToolsByName() {
        Tool first = tool("first");
        Tool second = tool("second");
        ToolRegistry registry = new ToolRegistry(List.of(first));

        registry.register(second);

        assertThat(registry.getTool("first")).isSameAs(first);
        assertThat(registry.getAllTools()).containsExactlyInAnyOrder(first, second);
        assertThat(registry.getToolsByNames(List.of("missing", "second", "first")))
                .containsExactly(second, first);
    }

    private Tool tool(String name) {
        return new Tool() {
            @Override
            public String getName() {
                return name;
            }

            @Override
            public String getDescription() {
                return name;
            }

            @Override
            public Map<String, Object> getInputSchema() {
                return Map.of();
            }

            @Override
            public Map<String, Object> getOutputSchema() {
                return Map.of();
            }

            @Override
            public String execute(String arguments) {
                return name + ":" + arguments;
            }
        };
    }
}
