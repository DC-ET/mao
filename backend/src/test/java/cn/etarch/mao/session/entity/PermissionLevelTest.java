package cn.etarch.mao.session.entity;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class PermissionLevelTest {

    @Test
    void fromStringDefaultsInvalidValuesToReadOnly() {
        assertThat(PermissionLevel.fromString("FULL")).isEqualTo(PermissionLevel.FULL);
        assertThat(PermissionLevel.fromString(null)).isEqualTo(PermissionLevel.READ_ONLY);
        assertThat(PermissionLevel.fromString("bad")).isEqualTo(PermissionLevel.READ_ONLY);
    }
}
