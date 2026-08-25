package top.eduplayer.reader;

import android.os.Bundle;
import android.os.Build;
import android.os.SystemClock;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final long EXIT_CONFIRM_WINDOW_MS = 2000;
    private static final String WEB_BACK_HANDLER =
        "(function(){" +
        "var b=document.body;" +
        "if(!b){return 'unhandled';}" +
        "var overlay=b.classList.contains('mobile-theme-open')||b.classList.contains('mobile-menu-open')||" +
        "b.classList.contains('speaking-menu-open')||b.classList.contains('speaking-chapters-open')||" +
        "b.classList.contains('speaking-growth-open');" +
        "if(overlay){var x=document.querySelector('[data-mobile-backdrop],#speakingMobileBackdrop');" +
        "if(x){x.click();}return 'handled';}" +
        "if(b.dataset&&b.dataset.studyMode==='quiz'){" +
        "var learn=document.querySelector('.mobile-learning-nav [data-mode-button=learn]')||" +
        "document.querySelector('[data-mode-button=learn]');" +
        "if(learn){learn.click();return 'handled';}}" +
        "return 'unhandled';" +
        "})()";

    private long lastBackPressedAt = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureWebView();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handleAppBack();
            }
        });
    }

    private void configureWebView() {
        WebView webView = getBridge().getWebView();
        WebSettings settings = webView.getSettings();
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, false);
    }

    private void handleAppBack() {
        WebView webView = getBridge().getWebView();
        webView.evaluateJavascript(WEB_BACK_HANDLER, result -> {
            if ("\"handled\"".equals(result)) {
                return;
            }
            if (webView.canGoBack()) {
                webView.goBack();
                return;
            }
            long now = SystemClock.elapsedRealtime();
            if (now - lastBackPressedAt <= EXIT_CONFIRM_WINDOW_MS) {
                finishAndRemoveTask();
                return;
            }
            lastBackPressedAt = now;
            Toast.makeText(this, R.string.press_back_again, Toast.LENGTH_SHORT).show();
        });
    }
}
