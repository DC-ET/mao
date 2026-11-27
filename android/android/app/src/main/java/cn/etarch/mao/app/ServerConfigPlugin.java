package cn.etarch.mao.app;

import android.app.Activity;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 暴露给远端 SPA 的最小服务器配置面：get / openPicker。
 *
 * 不提供 set / probe：写配置必须经过原生 picker 的用户确认，避免远端页面静默切站。
 */
@CapacitorPlugin(name = "ServerConfig")
public class ServerConfigPlugin extends Plugin {

    private boolean pickerOpen = false;

    @PluginMethod
    public void get(PluginCall call) {
        try {
            String baseUrl = ServerConfigStore.getEffectiveBaseUrl(getContext());
            JSObject result = new JSObject();
            result.put("serverBaseUrl", baseUrl);
            result.put("allowHttp", baseUrl.startsWith("http://") || ServerConfigStore.getAllowHttp(getContext()));
            result.put("shellVersionCode", BuildConfig.VERSION_CODE);
            result.put("shellVersionName", BuildConfig.VERSION_NAME);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("读取服务器配置失败：" + e.getMessage());
        }
    }

    @PluginMethod
    public void openPicker(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("当前页面不可用");
            return;
        }
        if (pickerOpen) {
            call.reject("服务器设置已打开");
            return;
        }
        pickerOpen = true;
        Intent intent = new Intent(activity, ServerPickerActivity.class);
        startActivityForResult(call, intent, "pickerResult");
    }

    @ActivityCallback
    private void pickerResult(PluginCall call, ActivityResult result) {
        pickerOpen = false;
        boolean changed = result.getResultCode() == Activity.RESULT_OK
                && result.getData() != null
                && result.getData().getBooleanExtra(ServerPickerActivity.EXTRA_CHANGED, false);
        if (call != null) call.resolve(new JSObject().put("changed", changed));
        if (changed) {
            Activity activity = getActivity();
            if (activity != null) {
                activity.runOnUiThread(() ->
                        new Handler(Looper.getMainLooper()).postDelayed(
                                () -> AppRestart.restart(activity),
                                200
                        ));
            }
        }
    }
}