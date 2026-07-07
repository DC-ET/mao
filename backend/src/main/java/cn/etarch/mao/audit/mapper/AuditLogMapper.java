package cn.etarch.mao.audit.mapper;

import cn.etarch.mao.audit.entity.AuditLog;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface AuditLogMapper extends BaseMapper<AuditLog> {
}
