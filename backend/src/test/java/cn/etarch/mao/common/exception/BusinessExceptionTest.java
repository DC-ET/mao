package cn.etarch.mao.common.exception;

import cn.etarch.mao.common.result.ErrorCode;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class BusinessExceptionTest {

    @Test
    void constructorsPreserveCodeAndMessage() {
        BusinessException byCode = new BusinessException(ErrorCode.PARAM_INVALID);
        BusinessException customMessage = new BusinessException(ErrorCode.PARAM_INVALID, "参数 bad");
        BusinessException customCode = new BusinessException(499, "custom");

        assertThat(byCode.getCode()).isEqualTo(ErrorCode.PARAM_INVALID.getCode());
        assertThat(byCode.getMessage()).isEqualTo(ErrorCode.PARAM_INVALID.getMessage());
        assertThat(customMessage.getCode()).isEqualTo(ErrorCode.PARAM_INVALID.getCode());
        assertThat(customMessage.getMessage()).isEqualTo("参数 bad");
        assertThat(customCode.getCode()).isEqualTo(499);
        assertThat(customCode.getMessage()).isEqualTo("custom");
    }
}
