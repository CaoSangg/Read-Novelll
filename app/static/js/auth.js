/* Existing opaque-cookie API; credentials and CSRF tokens stay out of storage. */
(() => {
  'use strict';
  const form = document.getElementById('auth-form');
  if (!form) return;
  const register = form.dataset.mode === 'register';
  const submit = document.getElementById('auth-submit');
  const label = submit.querySelector('[data-submit-label]');
  const spinner = submit.querySelector('.auth-spinner');
  const errorBox = document.getElementById('auth-error');
  const status = document.getElementById('auth-status');
  const inputs = Array.from(form.querySelectorAll('input'));
  const idleLabel = label.textContent;
  let busy = false;
  let completed = false;
  let retryAt = 0;
  let retryTimer;

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    errorBox.focus();
  }

  function fieldError(input, message) {
    const target = document.getElementById(`${input.id}-error`);
    target.textContent = message;
    target.hidden = !message;
    input.setAttribute('aria-invalid', String(Boolean(message)));
  }

  function updateButton() {
    const wait = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    submit.disabled = busy || completed || wait > 0;
    form.setAttribute('aria-busy', String(busy));
    spinner.hidden = !busy;
    label.textContent = wait > 0 ? `Thử lại sau ${wait} giây` : busy
      ? (register ? 'Đang Khởi Tạo Tài Khoản...' : 'Đang Tiến Nhập...') : idleLabel;
  }

  async function request(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {
        ...options, credentials: 'same-origin', cache: 'no-store',
        signal: controller.signal,
      });
      // Do not display raw server responses or validation input values.
      const data = await response.json().catch(() => ({}));
      return { response, data };
    } finally {
      clearTimeout(timeout);
    }
  }

  function limitRetry(response) {
    const value = response.headers.get('Retry-After');
    const seconds = value !== null && /^\d+$/.test(value) ? Number(value) : NaN;
    const date = value ? Date.parse(value) : NaN;
    retryAt = Number.isFinite(seconds) ? Date.now() + seconds * 1000
      : Number.isFinite(date) ? Math.max(Date.now(), date) : Date.now() + 60000;
    clearInterval(retryTimer);
    retryTimer = setInterval(() => {
      updateButton();
      if (Date.now() >= retryAt) clearInterval(retryTimer);
    }, 1000);
  }

  function handleFailure(response, data) {
    if (response.status === 429) {
      limitRetry(response);
      showError('Bạn đã thử quá nhiều lần. Vui lòng chờ rồi thử lại.');
    } else if (response.status === 401) {
      showError(data.detail === 'Account is disabled. Please contact an administrator.'
        ? 'Tài khoản đã bị vô hiệu hóa. Vui lòng liên hệ quản trị viên.'
        : 'Tên tài khoản, email hoặc mật khẩu không chính xác. Vui lòng kiểm tra lại.');
    } else if (response.status === 403) {
      showError('Không thể xác minh yêu cầu bảo mật. Vui lòng thử lại để lấy mã CSRF mới.');
    } else if (register && response.status === 400 &&
      ['Email is already registered', 'Username is already taken'].includes(data.detail)) {
      showError('Email hoặc tên tài khoản đã được sử dụng. Vui lòng kiểm tra lại hoặc đăng nhập.');
    } else if (response.status === 422) {
      const messages = {
        username: 'Tên tài khoản cần 3–50 ký tự: chữ Latin, số, dấu gạch dưới, chấm hoặc gạch ngang.',
        email: 'Vui lòng nhập địa chỉ email hợp lệ (5–255 ký tự).',
        username_or_email: 'Tên tài khoản hoặc email cần 3–255 ký tự.',
        password: register ? 'Mật khẩu cần 8–128 ký tự.' : 'Mật khẩu cần 1–128 ký tự.',
      };
      if (Array.isArray(data.detail)) {
        for (const issue of data.detail) {
          const name = Array.isArray(issue.loc) ? issue.loc[1] : '';
          const input = inputs.find((item) => item.name === name);
          if (input && messages[name]) fieldError(input, messages[name]);
        }
      }
      showError('Thông tin chưa hợp lệ. Vui lòng kiểm tra các trường đã nhập.');
    } else {
      showError('Máy chủ chưa thể xử lý yêu cầu. Vui lòng thử lại sau.');
    }
  }

  for (const toggle of form.querySelectorAll('.auth-toggle')) {
    toggle.disabled = false;
    toggle.addEventListener('click', () => {
      const input = document.getElementById(toggle.getAttribute('aria-controls'));
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      toggle.setAttribute('aria-pressed', String(visible));
      const suffix = input.id === 'confirm-password' ? 'xác nhận mật khẩu' : 'mật khẩu';
      toggle.setAttribute('aria-label', `${visible ? 'Ẩn' : 'Hiện'} ${suffix}`);
      toggle.querySelector('.auth-eye-slash').hidden = !visible;
    });
  }

  for (const input of inputs) {
    input.addEventListener('input', () => fieldError(input, ''));
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || completed || Date.now() < retryAt) return;
    errorBox.hidden = true;
    status.hidden = true;
    const identifier = document.getElementById('identifier');
    identifier.value = identifier.value.trim();
    if (register) document.getElementById('username').value = document.getElementById('username').value.trim();
    const password = document.getElementById('password');
    let firstInvalid;
    for (const input of inputs) {
      let message = '';
      const length = Array.from(input.value).length;
      if (!length) message = 'Vui lòng điền trường này.';
      else if ((input.minLength > 0 && length < input.minLength) || length > input.maxLength) {
        message = `Vui lòng nhập ${input.minLength > 0 ? input.minLength : 1}–${input.maxLength} ký tự.`;
      } else if (input.id === 'username' && !/^[a-zA-Z0-9_.-]+$/.test(input.value)) {
        message = 'Chỉ dùng chữ Latin, số, dấu gạch dưới, chấm hoặc gạch ngang.';
      } else if (register && input === identifier &&
        !/^[a-zA-Z0-9_.+\-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$/.test(input.value)) {
        message = 'Vui lòng nhập địa chỉ email hợp lệ.';
      } else if (input.id === 'confirm-password' && input.value !== password.value) {
        message = 'Mật khẩu xác nhận không khớp.';
      }
      fieldError(input, message);
      if (message && !firstInvalid) firstInvalid = input;
    }
    if (firstInvalid) {
      showError('Vui lòng kiểm tra thông tin đã nhập.');
      firstInvalid.focus();
      return;
    }
    busy = true;
    updateButton();
    try {
      // Bootstrap from the existing endpoint; no generated or hardcoded token.
      // Login/register require the existing double-submit CSRF dependency.
      const csrf = await request('/api/auth/csrf-token');
      if (!csrf.response.ok) {
        handleFailure(csrf.response, csrf.data);
        return;
      }
      if (typeof csrf.data.csrf_token !== 'string' || !csrf.data.csrf_token) {
        showError('Không lấy được mã bảo mật. Vui lòng thử lại.');
        return;
      }
      const payload = register
        ? { username: document.getElementById('username').value, email: identifier.value, password: password.value }
        : { username_or_email: identifier.value, password: password.value };
      const result = await request(form.getAttribute('action'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [form.dataset.csrfHeader]: csrf.data.csrf_token },
        body: JSON.stringify(payload),
      });
      if (!result.response.ok) {
        handleFailure(result.response, result.data);
        return;
      }
      completed = true;
      for (const input of inputs) {
        if (input.autocomplete.includes('password')) input.value = '';
      }
      const readerReturn = form.dataset.readerReturn;
      const success = register ? 'Đăng ký thành công!' : 'Đăng nhập thành công!';
      status.textContent = success + (readerReturn ? ' Đang quay lại chương đang đọc…' :
        ' Đang chuyển về Trang chủ...');
      status.hidden = false;
      // The server emits an allowlisted Reader return URL or an empty value.
      setTimeout(() => window.location.replace(readerReturn || '/'), register ? 1500 : 300);
    } catch (error) {
      showError(error.name === 'AbortError'
        ? 'Yêu cầu quá thời gian chờ. Hãy kiểm tra trạng thái tài khoản trước khi thử lại.'
        : 'Không thể kết nối đến máy chủ. Vui lòng kiểm tra kết nối mạng.');
    } finally {
      busy = false;
      updateButton();
    }
  });

  updateButton();
  // Reuse current-user validation, including expired sessions and disabled users.
  // A failed probe keeps the form usable; it never redirects to an auth page.
  request('/api/auth/me').then(({ response }) => {
    if (response.ok && !busy && !completed) {
      window.location.replace(form.dataset.readerReturn || '/');
    }
  }).catch(() => {});
})();
