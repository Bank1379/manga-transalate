import re

file_path = 'extension/content/content.js'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Find the end of the IIFE
match = re.search(r'\}\)\(\);', content)
if match:
    clean_content = content[:match.end()]
    
    # Append the correct code
    correct_code = '''

// ==========================================
// BUBBLE CONTEXT MENU
// ==========================================
let currentContextMenu = null;

function showBubbleContextMenu(bubble, x, y) {
  // Remove existing if any
  if (currentContextMenu) {
    currentContextMenu.remove();
  }

  const menu = document.createElement("div");
  menu.className = "scanlate-context-menu";
  
  // Convert RGB string to Hex for input[type='color']
  function rgbToHex(rgbStr) {
    const match = rgbStr.match(/\d+/g);
    if (!match || match.length < 3) return '#ffffff';
    return '#' + match.slice(0,3).map(x => {
      const hex = parseInt(x).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    }).join('');
  }

  const currentBg = rgbToHex(bubble.style.backgroundColor);
  const currentFg = rgbToHex(bubble.style.color);

  menu.innerHTML = \
    <div class="scanlate-context-menu-item" id="ctx-light">
      <span>??</span> <span>????????? (Light)</span>
    </div>
    <div class="scanlate-context-menu-item" id="ctx-dark">
      <span>??</span> <span>??????? (Dark)</span>
    </div>
    <div class="scanlate-context-menu-divider"></div>
    <div class="scanlate-color-picker-group">
      <label>?? ????????</label>
      <input type="color" id="ctx-bg-color" value="\">
    </div>
    <div class="scanlate-color-picker-group">
      <label>?? ????????</label>
      <input type="color" id="ctx-fg-color" value="\">
    </div>
    <div class="scanlate-context-menu-divider"></div>
    <div class="scanlate-context-menu-item" id="ctx-delete" style="color: #ef4444;">
      <span>???</span> <span>?????????</span>
    </div>
  \;

  // Position menu
  menu.style.left = \\px\;
  menu.style.top = \\px\;

  document.body.appendChild(menu);
  currentContextMenu = menu;

  // Prevent click inside menu from closing it
  menu.addEventListener("click", (e) => e.stopPropagation());

  // Event Listeners
  menu.querySelector("#ctx-light").addEventListener("click", () => {
    bubble.style.backgroundColor = 'rgb(245, 245, 245)';
    bubble.style.color = 'rgb(30, 30, 30)';
    bubble.style.textShadow = '-1px -1px 2px rgba(255,255,255,0.95), 1px -1px 2px rgba(255,255,255,0.95), -1px 1px 2px rgba(255,255,255,0.95), 1px 1px 2px rgba(255,255,255,0.95)';
  });

  menu.querySelector("#ctx-dark").addEventListener("click", () => {
    bubble.style.backgroundColor = 'rgb(30, 30, 30)';
    bubble.style.color = 'rgb(245, 245, 245)';
    bubble.style.textShadow = '-1px -1px 2px rgba(0,0,0,0.95), 1px -1px 2px rgba(0,0,0,0.95), -1px 1px 2px rgba(0,0,0,0.95), 1px 1px 2px rgba(0,0,0,0.95)';
  });

  menu.querySelector("#ctx-bg-color").addEventListener("input", (e) => {
    bubble.style.backgroundColor = e.target.value;
  });

  menu.querySelector("#ctx-fg-color").addEventListener("input", (e) => {
    bubble.style.color = e.target.value;
  });

  menu.querySelector("#ctx-delete").addEventListener("click", () => {
    bubble.remove();
    menu.remove();
    currentContextMenu = null;
  });
}

// Close context menu when clicking outside
document.addEventListener("click", (e) => {
  if (currentContextMenu && !currentContextMenu.contains(e.target)) {
    currentContextMenu.remove();
    currentContextMenu = null;
  }
});
'''
    
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(clean_content + correct_code)
    print("Fixed content.js")
else:
    print("Could not find end of IIFE")
