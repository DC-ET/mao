package cn.etarch.mao.harness.core;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ToolAttachment {

    private String mime;
    private String path;
    private String dataUri;
}
