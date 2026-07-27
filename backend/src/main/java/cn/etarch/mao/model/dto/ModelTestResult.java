package cn.etarch.mao.model.dto;

import lombok.Builder;
import lombok.Data;

@Data
@Builder
public class ModelTestResult {
    /**
     * 基本连通性测试是否通过
     */
    private boolean connectivity;
    
    /**
     * Mid system message 测试是否通过
     */
    private boolean midSystemMessage;
    
    /**
     * 测试过程中的错误信息（如果有）
     */
    private String error;
    
    /**
     * 测试耗时（毫秒）
     */
    private long durationMs;
}