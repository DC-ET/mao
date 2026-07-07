package cn.etarch.mao.session.entity;

public enum PermissionLevel {
    READ_ONLY,
    READ_WRITE,
    SMART,
    FULL;

    public static PermissionLevel fromString(String value) {
        if (value == null) return READ_ONLY;
        try {
            return valueOf(value);
        } catch (IllegalArgumentException e) {
            return READ_ONLY;
        }
    }
}
