package cn.etarch.mao.permission.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

@Data
@TableName("role")
public class Role {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String name;

    private String code;

    private String description;

    /** Logical deletion flag: 0=normal, 1=deleted */
    @TableLogic
    private Integer deleted;
}
