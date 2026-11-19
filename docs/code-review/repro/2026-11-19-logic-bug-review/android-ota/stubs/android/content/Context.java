package android.content;
import java.io.File;
import android.content.pm.PackageManager;
/** 最小桩：仅覆盖 AppUpdatePlugin 用到的签名。externalFilesDir 可由测试注入/重置。 */
public class Context {
    private File externalFilesDir = new File(System.getProperty("java.io.tmpdir"), "mao-ota-repro-default");
    public void setExternalFilesDir(File dir) { this.externalFilesDir = dir; }
    public File getExternalFilesDir(String type) { return externalFilesDir; }
    public PackageManager getPackageManager() { return new PackageManager(); }
    public String getPackageName() { return "cn.etarch.mao.app.test"; }
}
