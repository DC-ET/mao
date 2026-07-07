package com.agentworkbench.common.result;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class ResultTest {

    @Test
    void okBuildsSuccessResponseWithTimestamp() {
        Result<String> result = Result.ok("data");

        assertThat(result.getCode()).isZero();
        assertThat(result.getMessage()).isEqualTo("success");
        assertThat(result.getData()).isEqualTo("data");
        assertThat(result.getTimestamp()).isPositive();
    }

    @Test
    void failBuildsErrorResponses() {
        Result<Object> custom = Result.fail(123, "bad");
        Result<Object> fromCode = Result.fail(ErrorCode.PARAM_INVALID);

        assertThat(custom.getCode()).isEqualTo(123);
        assertThat(custom.getMessage()).isEqualTo("bad");
        assertThat(fromCode.getCode()).isEqualTo(ErrorCode.PARAM_INVALID.getCode());
        assertThat(fromCode.getMessage()).isEqualTo(ErrorCode.PARAM_INVALID.getMessage());
    }
}
