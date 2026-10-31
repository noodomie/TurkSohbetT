'use strict';

(() => {
  const $ = (selector) => document.querySelector(selector);
  const landing = $('#landing');
  const chat = $('#chat');
  const joinForm = $('#join-form');
  const nameInput = $('#name-input');
  const nameError = $('#name-error');
  const joinButton = $('#join-button');
  const leaveButton = $('#leave-button');
  const connectionLabel = $('#connection-label');
  const peopleList = $('#people-list');
  const onlineCount = $('#online-count');
  const youLabel = $('#you-label');
  const messageList = $('#message-list');
  const messagesArea = $('#messages');
  const emptyState = $('#empty-state');
  const composer = $('#composer');
  const messageInput = $('#message-input');
  const sendButton = $('#send-button');
  const charCount = $('#char-count');
  const chatNotice = $('#chat-notice');
  const replyBar = $('#reply-bar');
  const replyName = $('#reply-name');
  const replyText = $('#reply-text');
  const cancelReply = $('#cancel-reply');
  const menu = $('#message-menu');
  const menuBackdrop = $('#menu-backdrop');
  const toast = $('#toast');

  const NAME_PATTERN = /^[ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZabcçdefgğhıijklmnoöprsştuüvyz0-9]{3,16}$/u;
  const MAX_CHARS = 200;
  let socket = null;
  let myName = '';
  let joined = false;
  let pendingReply = null;
  let editingMessageId = null;
  let selectedMessage = null;
  let toastTimer = null;
  let noticeTimer = null;
  let reconnecting = false;
  let isSending = false;
  const renderedMessages = new Map();

  function setFieldError(message) {
    nameError.textContent = message || '';
    nameInput.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function setChatNotice(message) {
    chatNotice.textContent = message || '';
    clearTimeout(noticeTimer);
    if (message) {
      noticeTimer = setTimeout(() => { chatNotice.textContent = ''; }, 4200);
    }
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.remove('is-hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('is-hidden'), 1900);
  }

  function setJoining(isJoining) {
    joinButton.disabled = isJoining;
    joinButton.querySelector('span').textContent = isJoining ? 'Bağlanıyor...' : 'Katıl';
  }

  function validateName(value) {
    const name = value.normalize('NFC').trim();
    return name.length >= 3 && Array.from(name).length <= 16 && NAME_PATTERN.test(name) ? name : null;
  }

  function connectAndJoin(name) {
    myName = name;
    reconnecting = false;
    if (!socket) {
      socket = io({
        autoConnect: false,
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        timeout: 10000
      });
      registerSocketEvents();
    }
    if (socket.connected) {
      socket.emit('join', { name: myName });
    } else {
      setJoining(true);
      socket.connect();
    }
  }

  function registerSocketEvents() {
    socket.on('connect', () => {
      connectionLabel.textContent = 'Bağlanıyor';
      connectionLabel.parentElement.classList.remove('is-offline');
      if (myName && !joined) socket.emit('join', { name: myName });
      else if (joined) {
        connectionLabel.textContent = 'Bağlandı';
        connectionLabel.parentElement.classList.remove('is-offline');
      }
    });

    socket.on('join:success', (data) => {
      joined = true;
      myName = data.name;
      setJoining(false);
      setFieldError('');
      landing.classList.add('is-hidden');
      chat.classList.remove('is-hidden');
      youLabel.textContent = `Sen: ${myName}`;
      clearMessageList();
      (Array.isArray(data.messages) ? data.messages : []).forEach((message) => addMessage(message, false));
      updateUsers(data.users || []);
      connectionLabel.textContent = 'Bağlandı';
      connectionLabel.parentElement.classList.remove('is-offline');
      setChatNotice('');
      scrollToBottom(false);
      setTimeout(() => messageInput.focus({ preventScroll: true }), 180);
      if (reconnecting) showToast('Bağlantı yeniden kuruldu.');
      reconnecting = false;
      updateCharacterCount();
    });

    socket.on('join:error', (data) => {
      joined = false;
      setJoining(false);
      landing.classList.remove('is-hidden');
      chat.classList.add('is-hidden');
      setFieldError(data && data.message ? data.message : 'Hatalı İsim!');
      socket.disconnect();
    });

    socket.on('users:update', updateUsers);
    socket.on('message:new', (message) => addMessage(message, true));
    socket.on('message:updated', updateMessage);
    socket.on('message:deleted', (data) => removeMessage(data.id));

    socket.on('server:notice', (data) => {
      const message = data && typeof data.message === 'string' ? data.message : 'Bir işlem gerçekleştirilemedi.';
      if (joined) setChatNotice(message);
      else setFieldError(message);
    });

    socket.on('disconnect', (reason) => {
      if (!joined) return;
      joined = false;
      isSending = false;
      reconnecting = true;
      connectionLabel.textContent = 'Yeniden bağlanıyor';
      connectionLabel.parentElement.classList.add('is-offline');
      setChatNotice('Bağlantı kesildi. Yeniden bağlanılıyor...');
      updateCharacterCount();
      if (reason === 'io server disconnect') socket.connect();
    });

    socket.on('connect_error', () => {
      updateCharacterCount();
      if (joined) {
        connectionLabel.textContent = 'Bağlantı bekleniyor';
        connectionLabel.parentElement.classList.add('is-offline');
      } else {
        setJoining(false);
        setFieldError('Sunucuya bağlanılamadı. Tekrar dene.');
      }
    });
  }

  function clearMessageList() {
    messageList.replaceChildren();
    renderedMessages.clear();
    emptyState.classList.remove('is-hidden');
  }

  function updateUsers(users) {
    if (!Array.isArray(users)) return;
    const fragment = document.createDocumentFragment();
    users.forEach((user) => {
      if (!user || typeof user.name !== 'string') return;
      const chip = document.createElement('div');
      chip.className = 'person-chip';
      const avatar = document.createElement('span');
      avatar.className = 'person-avatar';
      avatar.textContent = Array.from(user.name)[0] || '?';
      const name = document.createElement('span');
      name.className = 'person-name';
      name.textContent = user.name;
      chip.append(avatar, name);
      fragment.append(chip);
    });
    peopleList.replaceChildren(fragment);
    const count = users.length;
    onlineCount.textContent = `${count} ${count === 1 ? 'kişi' : 'kişi'}`;
  }

  function timeLabel(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(date);
  }

  function appendLinkedText(container, text) {
    const pattern = /((?:https?:\/\/|www\.)[^\s<>"']+)/giu;
    let lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[0];
      let candidate = raw;
      let trailing = '';
      while (/[.,!?;:)\]}]$/u.test(candidate)) {
        trailing = candidate.slice(-1) + trailing;
        candidate = candidate.slice(0, -1);
      }
      if (match.index > lastIndex) container.append(document.createTextNode(text.slice(lastIndex, match.index)));
      let url;
      try {
        url = new URL(candidate.startsWith('www.') ? `https://${candidate}` : candidate);
      } catch (_error) {
        container.append(document.createTextNode(raw));
        lastIndex = match.index + raw.length;
        continue;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        container.append(document.createTextNode(raw));
      } else {
        const link = document.createElement('a');
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer nofollow';
        link.textContent = candidate;
        link.setAttribute('aria-label', `Bağlantıyı aç: ${candidate}`);
        container.append(link, document.createTextNode(trailing));
      }
      lastIndex = match.index + raw.length;
    }
    if (lastIndex < text.length) container.append(document.createTextNode(text.slice(lastIndex)));
  }

  function createReplyPreview(replyTo) {
    const preview = document.createElement('div');
    preview.className = 'reply-preview';
    preview.dataset.replyId = replyTo.id;
    const sender = document.createElement('strong');
    sender.textContent = replyTo.sender;
    const excerpt = document.createElement('span');
    excerpt.textContent = replyTo.text;
    preview.append(sender, excerpt);
    preview.addEventListener('click', () => {
      const target = renderedMessages.get(replyTo.id);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('highlight-message');
        setTimeout(() => target.classList.remove('highlight-message'), 900);
      }
    });
    return preview;
  }

  function addMessage(message, shouldScroll) {
    if (!message || typeof message.id !== 'string' || renderedMessages.has(message.id)) return;
    if (message.system) {
      const system = document.createElement('div');
      system.className = 'system-message';
      system.dataset.messageId = message.id;
      system.textContent = message.text;
      messageList.append(system);
      renderedMessages.set(message.id, system);
    } else {
      const mine = message.sender === myName;
      const row = document.createElement('article');
      row.className = `message-row${mine ? ' mine' : ''}`;
      row.dataset.messageId = message.id;

      const meta = document.createElement('div');
      meta.className = 'message-meta';
      const sender = document.createElement('span');
      sender.className = 'message-sender';
      sender.textContent = message.sender;
      const time = document.createElement('time');
      time.className = 'message-time';
      time.textContent = timeLabel(message.timestamp);
      meta.append(sender, time);

      const bubble = document.createElement('div');
      bubble.className = 'message-bubble';
      bubble.dataset.messageId = message.id;
      if (message.replyTo && message.replyTo.id) bubble.append(createReplyPreview(message.replyTo));

      const text = document.createElement('p');
      text.className = 'message-text';
      appendLinkedText(text, message.text);
      bubble.append(text);

      if (message.edited) {
        const edited = document.createElement('span');
        edited.className = 'edited-tag';
        edited.textContent = 'düzenlendi';
        time.after(edited);
      }
      row.append(meta, bubble);
      messageList.append(row);
      renderedMessages.set(message.id, row);
      attachMessageGestures(bubble, message);
    }

    if (messageList.children.length > 300) {
      const oldest = messageList.firstElementChild;
      if (oldest) {
        const oldestId = oldest.dataset.messageId;
        if (oldestId) renderedMessages.delete(oldestId);
        oldest.remove();
      }
    }
    emptyState.classList.toggle('is-hidden', messageList.children.length > 0);
    if (shouldScroll) scrollToBottom(true);
  }

  function updateMessage(message) {
    if (!message || typeof message.id !== 'string') return;
    const old = renderedMessages.get(message.id);
    if (!old) return;
    const wasMine = message.sender === myName;
    const row = document.createElement('article');
    row.className = `message-row${wasMine ? ' mine' : ''}`;
    row.dataset.messageId = message.id;
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const sender = document.createElement('span');
    sender.className = 'message-sender';
    sender.textContent = message.sender;
    const time = document.createElement('time');
    time.className = 'message-time';
    time.textContent = timeLabel(message.timestamp);
    const edited = document.createElement('span');
    edited.className = 'edited-tag';
    edited.textContent = 'düzenlendi';
    meta.append(sender, time, edited);
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.dataset.messageId = message.id;
    if (message.replyTo && message.replyTo.id) bubble.append(createReplyPreview(message.replyTo));
    const text = document.createElement('p');
    text.className = 'message-text';
    appendLinkedText(text, message.text);
    bubble.append(text);
    row.append(meta, bubble);
    old.replaceWith(row);
    renderedMessages.set(message.id, row);
    attachMessageGestures(bubble, message);
  }

  function removeMessage(id) {
    const element = renderedMessages.get(id);
    if (!element) return;
    element.remove();
    renderedMessages.delete(id);
    emptyState.classList.toggle('is-hidden', messageList.children.length > 0);
    if (selectedMessage && selectedMessage.id === id) closeMenu();
    if (pendingReply && pendingReply.id === id) clearReply();
    if (editingMessageId === id) cancelEditing();
  }

  function scrollToBottom(smooth) {
    requestAnimationFrame(() => {
      messagesArea.scrollTo({ top: messagesArea.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    });
  }

  function attachMessageGestures(element, message) {
    let holdTimer = null;
    let longPressed = false;
    let startX = 0;
    let startY = 0;
    const clearHold = () => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
    };

    element.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      clearHold();
      longPressed = false;
      startX = event.clientX;
      startY = event.clientY;
      holdTimer = setTimeout(() => {
        longPressed = true;
        openMenu(message, startX, startY);
      }, 430);
    });
    element.addEventListener('pointermove', (event) => {
      if (Math.abs(event.clientX - startX) > 9 || Math.abs(event.clientY - startY) > 9) clearHold();
    });
    element.addEventListener('pointerup', clearHold);
    element.addEventListener('pointercancel', clearHold);
    element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      clearHold();
      if (!longPressed) openMenu(message, event.clientX, event.clientY);
    });
  }

  function openMenu(message, x, y) {
    selectedMessage = message;
    const mine = message.sender === myName;
    menu.querySelectorAll('[data-action="edit"], [data-action="delete"]').forEach((button) => {
      button.classList.toggle('is-hidden', !mine);
    });
    menu.classList.remove('is-hidden');
    menuBackdrop.classList.remove('is-hidden');
    const rectWidth = 174;
    const rectHeight = mine ? 176 : 92;
    const left = Math.max(8, Math.min(x, window.innerWidth - rectWidth - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rectHeight - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function closeMenu() {
    menu.classList.add('is-hidden');
    menuBackdrop.classList.add('is-hidden');
    selectedMessage = null;
  }

  async function copyMessage(message) {
    try {
      await navigator.clipboard.writeText(message.text);
      showToast('Mesaj kopyalandı');
    } catch (_error) {
      const temporary = document.createElement('textarea');
      temporary.value = message.text;
      temporary.style.position = 'fixed';
      temporary.style.opacity = '0';
      document.body.append(temporary);
      temporary.select();
      const copied = document.execCommand('copy');
      temporary.remove();
      showToast(copied ? 'Mesaj kopyalandı' : 'Kopyalama desteklenmiyor');
    }
  }

  function setReply(message) {
    pendingReply = { id: message.id, sender: message.sender, text: message.text };
    replyName.textContent = `${message.sender} yanıtlanıyor`;
    replyText.textContent = message.text;
    replyBar.classList.remove('is-hidden');
    messageInput.focus({ preventScroll: true });
  }

  function clearReply() {
    pendingReply = null;
    replyBar.classList.add('is-hidden');
  }

  function startEditing(message) {
    editingMessageId = message.id;
    clearReply();
    messageInput.value = message.text;
    updateCharacterCount();
    sendButton.setAttribute('aria-label', 'Değişiklikleri kaydet');
    sendButton.title = 'Kaydet';
    messageInput.placeholder = 'Mesajı düzenle...';
    composer.classList.add('is-editing');
    messageInput.focus({ preventScroll: true });
    messageInput.setSelectionRange(messageInput.value.length, messageInput.value.length);
  }

  function cancelEditing() {
    editingMessageId = null;
    messageInput.value = '';
    resizeTextarea();
    updateCharacterCount();
    sendButton.setAttribute('aria-label', 'Mesaj gönder');
    sendButton.title = 'Gönder';
    messageInput.placeholder = 'Mesajını yaz...';
    composer.classList.remove('is-editing');
  }

  menu.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || !selectedMessage) return;
    const action = button.dataset.action;
    const message = selectedMessage;
    closeMenu();
    if (action === 'copy') copyMessage(message);
    if (action === 'reply') setReply(message);
    if (action === 'edit' && message.sender === myName) startEditing(message);
    if (action === 'delete' && message.sender === myName && socket && socket.connected) {
      socket.emit('message:delete', { id: message.id });
    }
  });

  menuBackdrop.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenu();
      if (editingMessageId) cancelEditing();
      else clearReply();
    }
  });

  function updateCharacterCount() {
    const count = Array.from(messageInput.value).length;
    charCount.textContent = `${count}/${MAX_CHARS}`;
    charCount.classList.toggle('is-near-limit', count >= 180);
    sendButton.disabled = isSending || !messageInput.value.trim() || count > MAX_CHARS || !socket || !socket.connected;
  }

  function resizeTextarea() {
    messageInput.style.height = 'auto';
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, 112)}px`;
  }

  joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = validateName(nameInput.value);
    if (!name) {
      setFieldError('Hatalı İsim!');
      nameInput.focus();
      return;
    }
    setFieldError('');
    setJoining(true);
    connectAndJoin(name);
  });

  nameInput.addEventListener('input', () => {
    if (nameError.textContent) setFieldError('');
  });

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = messageInput.value.trim();
    const count = Array.from(text).length;
    if (!text || count > MAX_CHARS || !socket || !socket.connected) return;

    const submittedText = text;
    const submittedEditId = editingMessageId;
    const submittedReplyId = pendingReply ? pendingReply.id : null;
    isSending = true;
    updateCharacterCount();
    const eventName = submittedEditId ? 'message:edit' : 'message:send';
    const payload = submittedEditId
      ? { id: submittedEditId, text: submittedText }
      : { text: submittedText, replyToId: submittedReplyId };
    socket.emit(eventName, payload, (result) => {
      isSending = false;
      if (!result || !result.ok) {
        setChatNotice(result && result.message ? result.message : 'Mesaj gönderilemedi.');
        updateCharacterCount();
        return;
      }
      if (submittedEditId) {
        if (editingMessageId === submittedEditId && messageInput.value.trim() === submittedText) cancelEditing();
      } else if (messageInput.value.trim() === submittedText) {
        messageInput.value = '';
        if (pendingReply && pendingReply.id === submittedReplyId) clearReply();
        resizeTextarea();
      }
      updateCharacterCount();
      setChatNotice('');
    });
  });

  messageInput.addEventListener('input', () => {
    resizeTextarea();
    updateCharacterCount();
  });

  messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });

  cancelReply.addEventListener('click', clearReply);

  leaveButton.addEventListener('click', () => {
    joined = false;
    isSending = false;
    myName = '';
    pendingReply = null;
    editingMessageId = null;
    closeMenu();
    clearReply();
    if (socket) socket.disconnect();
    socket = null;
    clearMessageList();
    chat.classList.add('is-hidden');
    landing.classList.remove('is-hidden');
    nameInput.value = '';
    setFieldError('');
    setJoining(false);
    updateUsers([]);
    messageInput.value = '';
    updateCharacterCount();
    connectionLabel.textContent = 'Bağlandı';
    connectionLabel.parentElement.classList.remove('is-offline');
  });

  window.addEventListener('online', () => {
    if (socket && !socket.connected) socket.connect();
  });

  updateCharacterCount();
})();
