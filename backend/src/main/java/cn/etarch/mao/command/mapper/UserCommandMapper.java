package cn.etarch.mao.command.mapper;

import cn.etarch.mao.command.entity.UserCommand;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface UserCommandMapper extends BaseMapper<UserCommand> {
}
