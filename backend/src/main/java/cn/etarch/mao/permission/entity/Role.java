package cn.etarch.mao.permission.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

@Data
@TableName("role")
public class Role {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String name;

    private String code;

    private String description;
}
