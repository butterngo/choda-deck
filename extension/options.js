const el = (id) => document.getElementById(id)

async function load() {
  const { base, token } = await chrome.storage.local.get(['base', 'token'])
  el('base').value = base || 'http://127.0.0.1:7338'
  el('token').value = token || ''
}

el('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    base: el('base').value.trim() || 'http://127.0.0.1:7338',
    token: el('token').value.trim()
  })
  el('saved').textContent = 'Saved ✓'
  setTimeout(() => (el('saved').textContent = ''), 1500)
})

load()
