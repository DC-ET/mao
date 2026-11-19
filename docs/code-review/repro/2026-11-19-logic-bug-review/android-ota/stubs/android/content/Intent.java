package android.content;
import android.net.Uri;
public class Intent {
    public static final int FLAG_ACTIVITY_NEW_TASK = 0x10000000;
    public static final String ACTION_VIEW = "android.intent.action.VIEW";
    public static final int FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;
    public Intent() { }
    public Intent(String action) { }
    public Intent(String action, Uri data) { }
    public Intent setDataAndType(Uri data, String type) { return this; }
    public Intent addFlags(int flags) { return this; }
}
