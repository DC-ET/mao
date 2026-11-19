package androidx.core.content;
import android.content.Context;
import android.net.Uri;
import java.io.File;
public final class FileProvider {
    private FileProvider() {}
    public static Uri getUriForFile(Context context, String authority, File file) { return Uri.parse("content://stub"); }
}
