package cn.etarch.mao.harness.mcp.mapper;

import cn.etarch.mao.harness.mcp.entity.McpServer;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface McpServerMapper extends BaseMapper<McpServer> {

    /**
     * 物理删除服务器记录。
     * 唯一索引 (user_id, name) 与逻辑删除不兼容：逻辑删除后索引残留会导致
     * 同名服务器无法重新创建。该表无恢复/审计需求，删除即物理删除。
     */
    @Delete("DELETE FROM mcp_server WHERE id = #{id}")
    int physicalDeleteById(Long id);
}
