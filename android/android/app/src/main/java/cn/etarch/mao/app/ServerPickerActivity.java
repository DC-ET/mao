package cn.etarch.mao.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 原生服务器设置页：输入 / 探测 / 历史 / 保存并切换。
 *
 * 不依赖远端 SPA：首屏加载失败、旧版前端、桌面快捷方式都能进入。
 */
public class ServerPickerActivity extends AppCompatActivity {

    public static final String EXTRA_CHANGED = "server_changed";

    private static final String STATE_URL = "state_url";
    private static final String STATE_ALLOW_HTTP = "state_allow_http";
    private static final String STATE_STATUS = "state_status";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private EditText urlInput;
    private CheckBox allowHttpCheck;
    private TextView currentUrlText;
    private TextView probeStatus;
    private LinearLayout historyContainer;
    private Button probeButton;
    private Button saveButton;
    private Button cancelButton;

    private boolean probing = false;
    private boolean destroyed = false;
    private int probeGeneration = 0;
    private String lastProbedUrl;
    private boolean lastProbeOk;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_server_picker);

        urlInput = findViewById(R.id.urlInput);
        allowHttpCheck = findViewById(R.id.allowHttpCheck);
        currentUrlText = findViewById(R.id.currentUrlText);
        probeStatus = findViewById(R.id.probeStatus);
        historyContainer = findViewById(R.id.historyContainer);
        probeButton = findViewById(R.id.probeButton);
        saveButton = findViewById(R.id.saveButton);
        cancelButton = findViewById(R.id.cancelButton);

        probeButton.setAllCaps(false);
        saveButton.setAllCaps(false);
        cancelButton.setAllCaps(false);

        String current = ServerConfigStore.getEffectiveBaseUrl(this);
        currentUrlText.setText(current);

        boolean defaultAllowHttp = current.startsWith("http://") || ServerConfigStore.getAllowHttp(this);
        if (savedInstanceState != null) {
            urlInput.setText(savedInstanceState.getString(STATE_URL, current));
            allowHttpCheck.setChecked(savedInstanceState.getBoolean(STATE_ALLOW_HTTP, defaultAllowHttp));
            probeStatus.setText(savedInstanceState.getString(STATE_STATUS, ""));
        } else {
            urlInput.setText(current);
            allowHttpCheck.setChecked(defaultAllowHttp);
        }
        urlInput.setSelection(urlInput.getText().length());

        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        cancelButton.setOnClickListener(v -> finish());
        probeButton.setOnClickListener(v -> doProbe(false));
        saveButton.setOnClickListener(v -> doSave());

        urlInput.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {}

            @Override
            public void afterTextChanged(Editable s) {
                clearProbe();
            }
        });
        allowHttpCheck.setOnCheckedChangeListener((buttonView, isChecked) -> clearProbe());

        renderHistory();
    }

    private void doProbe(boolean forSave) {
        if (probing) return;
        String base = normalizedInput();
        if (base == null) return;

        probing = true;
        setButtonsEnabled(false);
        setInputsEnabled(false);
        setStatus(getString(R.string.server_probing), false);
        final int generation = probeGeneration;
        executor.execute(() -> {
            ServerProbe.Result result;
            try {
                result = ServerProbe.probe(base, "MaoAndroid/" + BuildConfig.VERSION_NAME);
            } catch (Throwable t) {
                // 探测必须在任何异常下都回到 UI 线程，否则 picker 会永久卡在“正在检测”。
                result = ServerProbe.Result.error("INVALID_URL");
            }
            final ServerProbe.Result finalResult = result;
            mainHandler.post(() -> onProbeResult(generation, base, finalResult, forSave));
        });
    }

    private void onProbeResult(int generation, String base, ServerProbe.Result result, boolean forSave) {
        if (destroyed || generation != probeGeneration) return;
        probing = false;
        setButtonsEnabled(true);
        setInputsEnabled(true);

        if (result.ok) {
            lastProbedUrl = base;
            lastProbeOk = true;
            setStatus(getString(R.string.server_probe_ok, result.detail), false);
            if (forSave) saveNow(base);
            return;
        }

        lastProbeOk = false;
        if ("REDIRECT_ORIGIN".equals(result.errorCode) && result.finalBaseUrl != null) {
            String message = getString(R.string.server_redirect_message, result.finalBaseUrl);
            setStatus(message, true);
            new AlertDialog.Builder(this)
                    .setTitle(R.string.server_redirect_title)
                    .setMessage(message)
                    .setPositiveButton(R.string.server_use_final, (dialog, which) -> {
                        urlInput.setText(result.finalBaseUrl);
                        urlInput.setSelection(urlInput.getText().length());
                        // 最终地址是 HTTP 时自动勾选允许，避免用户回填后还要自己再找开关。
                        if (result.finalBaseUrl.startsWith("http://")) {
                            allowHttpCheck.setChecked(true);
                        }
                        clearProbe();
                    })
                    .setNegativeButton(R.string.server_cancel, null)
                    .show();
            return;
        }

        String readable = ServerProbe.describeError(result.errorCode);
        setStatus(getString(R.string.server_probe_error, readable), true);
        if (forSave) {
            new AlertDialog.Builder(this)
                    .setTitle(R.string.server_probe_failed_title)
                    .setMessage(getString(R.string.server_probe_failed_message, readable))
                    .setPositiveButton(R.string.server_save, (dialog, which) -> saveNow(base))
                    .setNegativeButton(R.string.server_cancel, null)
                    .show();
        }
    }

    private void doSave() {
        if (probing) return;
        String base = normalizedInput();
        if (base == null) return;

        if (base.startsWith("http://")) {
            new AlertDialog.Builder(this)
                    .setTitle(R.string.server_http_confirm_title)
                    .setMessage(R.string.server_http_confirm_message)
                    .setPositiveButton(android.R.string.ok, (dialog, which) -> proceedSave(base))
                    .setNegativeButton(R.string.server_cancel, null)
                    .show();
            return;
        }
        proceedSave(base);
    }

    private void proceedSave(String base) {
        if (base.equals(lastProbedUrl) && lastProbeOk) {
            saveNow(base);
            return;
        }
        doProbe(true);
    }

    private void saveNow(String base) {
        boolean allowHttp = allowHttpCheck.isChecked();
        boolean sameBase = base.equals(ServerConfigStore.getEffectiveBaseUrl(this));
        boolean sameAllowHttp = allowHttp == ServerConfigStore.getAllowHttp(this);
        if (sameBase && sameAllowHttp) {
            setStatus(getString(R.string.server_same_address), false);
            if (getCallingActivity() != null) setResult(Activity.RESULT_CANCELED);
            finish();
            return;
        }
        boolean saved = ServerConfigStore.save(this, base, allowHttp);
        if (!saved) {
            setStatus(getString(R.string.server_save_failed), true);
            return;
        }
        Intent data = new Intent();
        data.putExtra(EXTRA_CHANGED, true);
        setResult(Activity.RESULT_OK, data);
        if (getCallingActivity() == null) {
            AppRestart.restart(this);
        } else {
            finish();
        }
    }

    private String normalizedInput() {
        String input = urlInput.getText().toString().trim();
        ServerUrlNormalizer.Result result = ServerUrlNormalizer.normalize(input, allowHttpCheck.isChecked());
        if (!result.ok) {
            setStatus(result.error, true);
            return null;
        }
        return result.baseUrl;
    }

    private void clearProbe() {
        probeGeneration++;
        probing = false;
        lastProbedUrl = null;
        lastProbeOk = false;
        setButtonsEnabled(true);
        setInputsEnabled(true);
        if (probeStatus != null) probeStatus.setText("");
    }

    private void setButtonsEnabled(boolean enabled) {
        probeButton.setEnabled(enabled);
        saveButton.setEnabled(enabled);
    }

    private void setInputsEnabled(boolean enabled) {
        urlInput.setEnabled(enabled);
        allowHttpCheck.setEnabled(enabled);
    }

    private void setStatus(String text, boolean error) {
        if (TextUtils.isEmpty(text)) {
            probeStatus.setText("");
            return;
        }
        probeStatus.setTextColor(error ? Color.parseColor("#b91c1c") : Color.parseColor("#047857"));
        probeStatus.setText(text);
    }

    private void renderHistory() {
        historyContainer.removeAllViews();
        List<ServerHistory.Entry> entries = ServerConfigStore.getHistory(this);
        if (entries.isEmpty()) {
            TextView empty = new TextView(this);
            empty.setText(R.string.server_history_empty);
            empty.setTextColor(Color.parseColor("#6b7280"));
            empty.setTextSize(13);
            empty.setPadding(0, dp(8), 0, dp(8));
            historyContainer.addView(empty);
            return;
        }

        String current = ServerConfigStore.getEffectiveBaseUrl(this);
        LayoutInflater inflater = LayoutInflater.from(this);
        for (ServerHistory.Entry entry : entries) {
            View row = inflater.inflate(R.layout.item_server_history, historyContainer, false);

            TextView urlView = row.findViewById(R.id.historyUrl);
            TextView timeView = row.findViewById(R.id.historyTime);
            TextView httpTag = row.findViewById(R.id.historyHttpTag);
            Button switchButton = row.findViewById(R.id.switchButton);
            ImageButton deleteButton = row.findViewById(R.id.deleteButton);

            urlView.setText(entry.serverBaseUrl);
            boolean isHttpUrl = entry.serverBaseUrl.startsWith("http://");
            httpTag.setVisibility(isHttpUrl ? View.VISIBLE : View.GONE);
            String relative = entry.lastConnectedAt == null ? "" : formatRelative(entry.lastConnectedAt);
            timeView.setVisibility(TextUtils.isEmpty(relative) ? View.GONE : View.VISIBLE);
            timeView.setText(relative);

            boolean isCurrent = entry.serverBaseUrl.equals(current);
            switchButton.setEnabled(!isCurrent);
            switchButton.setText(isCurrent
                    ? getString(R.string.server_current_entry)
                    : getString(R.string.server_switch));
            switchButton.setOnClickListener(v -> switchTo(entry));

            deleteButton.setOnClickListener(v -> confirmDelete(entry));

            // 点行只回填输入框（可编辑后再保存），一键切换走「切换」按钮。
            row.setOnClickListener(v -> {
                urlInput.setText(entry.serverBaseUrl);
                urlInput.setSelection(urlInput.getText().length());
                allowHttpCheck.setChecked(entry.allowHttp);
                clearProbe();
            });
            historyContainer.addView(row);
        }
    }

    /** 历史条目一键切换：条目保存时已归一化并已确认过 allowHttp，直接保存并重启。 */
    private void switchTo(ServerHistory.Entry entry) {
        boolean saved = ServerConfigStore.save(this, entry.serverBaseUrl, entry.allowHttp);
        if (!saved) {
            setStatus(getString(R.string.server_save_failed), true);
            return;
        }
        Intent data = new Intent();
        data.putExtra(EXTRA_CHANGED, true);
        setResult(Activity.RESULT_OK, data);
        if (getCallingActivity() == null) {
            AppRestart.restart(this);
        } else {
            finish();
        }
    }

    private void confirmDelete(ServerHistory.Entry entry) {
        new AlertDialog.Builder(this)
                .setMessage(getString(R.string.server_delete_confirm, entry.serverBaseUrl))
                .setPositiveButton(R.string.server_delete, (dialog, which) -> {
                    ServerConfigStore.removeHistory(this, entry.serverBaseUrl);
                    renderHistory();
                })
                .setNegativeButton(R.string.server_cancel, null)
                .show();
    }

    /** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前，更早给日期。 */
    private String formatRelative(String iso) {
        try {
            SimpleDateFormat parser = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
            parser.setTimeZone(TimeZone.getTimeZone("UTC"));
            Date date = parser.parse(iso);
            if (date == null) return "";
            long minutes = Math.max(0, System.currentTimeMillis() - date.getTime()) / 60_000;
            if (minutes < 1) return "刚刚";
            if (minutes < 60) return minutes + " 分钟前";
            long hours = minutes / 60;
            if (hours < 24) return hours + " 小时前";
            long days = hours / 24;
            if (days < 30) return days + " 天前";
            return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(date);
        } catch (Exception e) {
            return "";
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putString(STATE_URL, urlInput.getText().toString());
        outState.putBoolean(STATE_ALLOW_HTTP, allowHttpCheck.isChecked());
        outState.putString(STATE_STATUS, probeStatus.getText().toString());
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        executor.shutdownNow();
        super.onDestroy();
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }
}