package cn.etarch.mao.permission.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

@Data
@TableName("role_permission")
public class RolePermission {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long roleId;

    private Long permissionId;
}
