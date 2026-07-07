package cn.etarch.mao.session.ws;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.Map;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class WsEvent {
    private String type;
    private Long sessionId;
    private Map<String, Object> data;

    public static WsEvent of(String type, Long sessionId, Map<String, Object> data) {
        return new WsEvent(type, sessionId, data);
    }
}
