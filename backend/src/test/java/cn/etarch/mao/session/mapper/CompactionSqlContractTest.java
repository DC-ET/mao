package cn.etarch.mao.session.mapper;

import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;

class CompactionSqlContractTest {

    @Test
    void incrementalMessageQueryUsesSessionDeletionAndStrictIdBoundary() throws Exception {
        Select annotation = MessageMapper.class
                .getMethod("selectMessagesAfterId", Long.class, Long.class)
                .getAnnotation(Select.class);
        String sql = String.join(" ", annotation.value()).replaceAll("\\s+", " ");

        assertThat(sql)
                .contains("session_id = #{sessionId}")
                .contains("deleted = 0")
                .contains("id > #{afterMessageId}")
                .contains("ORDER BY id ASC");
    }

    @Test
    void casUpdateRequiresOldBoundaryAdvanceAndLiveCandidateMessage() throws Exception {
        Update annotation = SessionCompactionMapper.class
                .getMethod("updateWithBoundaryCas", Long.class, Long.class, Long.class, Long.class,
                        String.class, long.class, long.class, String.class)
                .getAnnotation(Update.class);
        String sql = String.join(" ", annotation.value()).replaceAll("\\s+", " ");

        assertThat(sql)
                .contains("id = #{expectedRecordId}")
                .contains("COALESCE(last_compacted_msg_id, 0) = #{expectedOldBoundary}")
                .contains("#{newBoundary} > #{expectedOldBoundary}")
                .contains("m.id = #{newBoundary}")
                .contains("m.session_id = #{sessionId}")
                .contains("m.deleted = 0");
    }

    @Test
    void v062ClearsLegacyRecordsAndCreatesBoundaryIndex() throws Exception {
        String resource = "db/migration/V062__migrate_compaction_boundary_to_message_id.sql";
        try (InputStream stream = getClass().getClassLoader().getResourceAsStream(resource)) {
            assertThat(stream).isNotNull();
            String sql = new String(stream.readAllBytes(), StandardCharsets.UTF_8)
                    .replaceAll("\\s+", " ");
            assertThat(sql)
                    .contains("DELETE FROM `session_compaction`")
                    .contains("最后一条真实 message.id")
                    .contains("CREATE INDEX `idx_message_session_deleted_id`")
                    .contains("(`session_id`, `deleted`, `id`)");
        }
    }
}
