// CloudBox auth flows — register / login / logout + guards.
import { getClient, isConfigured, redirectIfAuthed, friendlyAuthError } from "./supabase.js";
import { toast } from "./utils.js";

function showConfigBanner() {
  document.querySelectorAll(".config-banner").forEach((el) => el.classList.add("show"));
}

function setLoading(form, loading, label) {
  const btn = form.querySelector('button[type="submit"]');
  if (!btn) return () => {};
  if (loading) {
    btn.disabled = true;
    btn.dataset.label = btn.textContent;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> ' + label;
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.label || btn.textContent;
  }
}

function showFormError(form, msg) {
  const box = form.querySelector(".form-error");
  if (box) { box.textContent = msg; box.classList.add("show"); }
  else toast(msg, "error");
}

function clearFieldErrors(form) {
  form.querySelectorAll(".field-error").forEach((e) => (e.textContent = ""));
  form.querySelectorAll("[aria-invalid]").forEach((i) => i.removeAttribute("aria-invalid"));
  const box = form.querySelector(".form-error");
  if (box) box.classList.remove("show");
}

function fieldError(input, msg) {
  input.setAttribute("aria-invalid", "true");
  const err = document.getElementById(input.getAttribute("aria-describedby") || "");
  if (err) err.textContent = msg;
}

const emailOk = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());

async function init() {
  if (!isConfigured()) showConfigBanner();

  const params = new URLSearchParams(location.search);
  const next = params.get("next");

  // Bounce authed users away from auth pages (only when configured).
  if (isConfigured()) {
    try { await redirectIfAuthed(next === "dashboard.html" || !next ? "dashboard.html" : next); } catch { /* offline */ }
  }

  const loginForm = document.getElementById("login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      clearFieldErrors(loginForm);
      const email = loginForm.querySelector("#email");
      const password = loginForm.querySelector("#password");
      let bad = false;
      if (!emailOk(email.value)) { fieldError(email, "Please enter a valid email address."); bad = true; }
      if (!password.value) { fieldError(password, "Please enter your password."); bad = true; }
      if (bad) return;
      const sb = getClient();
      if (!sb) { showFormError(loginForm, "Supabase is not configured yet. Copy js/supabase-config.example.js to js/supabase-config.js and add your keys."); return; }
      setLoading(loginForm, true, "Logging in…");
      try {
        const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: password.value });
        if (error) { showFormError(loginForm, friendlyAuthError(error)); return; }
        toast("Welcome back.", "success");
        location.href = next && next.endsWith(".html") ? next : "dashboard.html";
      } catch (err) {
        showFormError(loginForm, friendlyAuthError(err, "Unable to connect. Please try again."));
      } finally {
        setLoading(loginForm, false);
      }
    });
  }

  const regForm = document.getElementById("register-form");
  if (regForm) {
    regForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      clearFieldErrors(regForm);
      const name = regForm.querySelector("#name");
      const email = regForm.querySelector("#email");
      const password = regForm.querySelector("#password");
      let bad = false;
      if (name.value.trim().length < 2) { fieldError(name, "Please enter your name."); bad = true; }
      if (!emailOk(email.value)) { fieldError(email, "Please enter a valid email address."); bad = true; }
      if (password.value.length < 6) { fieldError(password, "Password must be at least 6 characters."); bad = true; }
      if (bad) return;
      const sb = getClient();
      if (!sb) { showFormError(regForm, "Supabase is not configured yet. Copy js/supabase-config.example.js to js/supabase-config.js and add your keys."); return; }
      setLoading(regForm, true, "Creating account…");
      try {
        const { error } = await sb.auth.signUp({
          email: email.value.trim(),
          password: password.value,
          options: { data: { full_name: name.value.trim() } },
        });
        if (error) { showFormError(regForm, friendlyAuthError(error)); return; }
        toast("Account created. You are signed in.", "success");
        location.href = "dashboard.html";
      } catch (err) {
        showFormError(regForm, friendlyAuthError(err, "Unable to connect. Please try again."));
      } finally {
        setLoading(regForm, false);
      }
    });
  }

  document.querySelectorAll("[data-logout]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const sb = getClient();
      if (sb) { try { await sb.auth.signOut(); } catch { /* ignore */ } }
      location.href = "login.html";
    });
  });
}

document.addEventListener("DOMContentLoaded", init);
