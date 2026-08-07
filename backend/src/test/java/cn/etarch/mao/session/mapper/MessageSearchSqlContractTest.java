package cn.etarch.mao.session.mapper;

import org.apache.ibatis.annotations.Select;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 会话消息搜索 SQL 契约测试：锁定关键过滤条件与转义约定，防止后续误改。
 */
class MessageSearchSqlContractTest {

    @Test
    void candidateQueryFiltersScopeAndProtectsOrphanSideTasks() throws Exception {
        Select annotation = SessionMapper.class
                .getMethod("selectMessageSearchCandidates", Long.class, String.class)
                .getAnnotation(Select.class);
        String sql = String.join(" ", annotation.value()).replaceAll("\\s+", " ");

        assertThat(sql)
                // 用户隔离
                .contains("s.user_id = #{userId}")
                // 范围：主会话 + 边路会话，排除子代理
                .contains("s.session_type IN ('NORMAL', 'SIDE_TASK')")
                // 只搜未归档会话
                .contains("s.status = 'ACTIVE'")
                .contains("s.deleted = 0")
                // 只匹配 user 消息（未删除）
                .contains("m.role = 'USER'")
                .contains("m.deleted = 0")
                // LIKE 转义显式声明
                .contains("ESCAPE '\\\\'")
                // 排序与上限
                .contains("ORDER BY s.updated_at DESC, s.id DESC")
                .contains("LIMIT 20")
                // 孤儿边路保护：父会话须同用户、未删、ACTIVE、NORMAL
                .contains("p.id = s.parent_session_id")
                .contains("p.user_id = s.user_id")
                .contains("p.status = 'ACTIVE'")
                .contains("p.session_type = 'NORMAL'")
                .contains("EXISTS");
    }

    @Test
    void hitMessagesQueryScopedByCandidateIdsOnePerSession() throws Exception {
        Select annotation = MessageMapper.class
                .getMethod("selectMessagesForSearch", java.util.List.class, String.class)
                .getAnnotation(Select.class);
        String sql = String.join(" ", annotation.value()).replaceAll("\\s+", " ");

        assertThat(sql)
                .contains("m.deleted = 0")
                .contains("m.role = 'USER'")
                .contains("m.session_id IN")
                .contains("ESCAPE '\\\\'")
                // 每会话仅取前几条命中消息（窗口函数 rn<=5），避免全局 LIMIT 截断
                // <script> 内比较符必须 XML 转义，否则启动时报 SAXParseException
                .contains("ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.id ASC)")
                .contains("WHERE t.rn &lt;= 5")
                .doesNotContain("LIMIT");
    }
}
