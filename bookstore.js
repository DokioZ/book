// 显示提示信息
function showToast(message, type = 'info') {
    // 创建提示元素
    const toast = document.createElement('div');
    toast.className = `fixed top-4 right-4 px-4 py-3 rounded-lg shadow-lg z-50 transform transition-all duration-300 ease-in-out translate-y-[-20px] opacity-0`;
    
    // 设置不同类型的样式
    if (type === 'success') {
        toast.classList.add('bg-green-500', 'text-white');
        toast.innerHTML = `<i class="fas fa-check-circle mr-2"></i>${message}`;
    } else if (type === 'error') {
        toast.classList.add('bg-red-500', 'text-white');
        toast.innerHTML = `<i class="fas fa-exclamation-circle mr-2"></i>${message}`;
    } else {
        toast.classList.add('bg-blue-500', 'text-white');
        toast.innerHTML = `<i class="fas fa-info-circle mr-2"></i>${message}`;
    }
    
    // 添加到页面
    document.body.appendChild(toast);
    
    // 显示动画
    setTimeout(() => {
        toast.classList.remove('translate-y-[-20px]', 'opacity-0');
    }, 10);
    
    // 自动关闭
    setTimeout(() => {
        toast.classList.add('translate-y-[-20px]', 'opacity-0');
        setTimeout(() => {
            document.body.removeChild(toast);
        }, 300);
    }, 3000);
}

// 检查用户是否已登录
function checkLoginStatus() {
    const isLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
    const token = localStorage.getItem('token');
    
    if (!isLoggedIn || !token) {
        // 不强制登录，允许匿名浏览
        return false;
    }
    
    // 验证token是否有效（这里只是简单检查，实际项目中应发送到服务器验证）
    try {
        const tokenParts = token.split('.');
        if (tokenParts.length !== 3) {
            throw new Error('无效的token格式');
        }
        // 解码payload部分
        const payload = JSON.parse(atob(tokenParts[1]));
        const exp = payload.exp * 1000; // 转换为毫秒
        if (Date.now() > exp) {
            throw new Error('token已过期');
        }
        
        // 更新页面上的用户名显示
        const username = localStorage.getItem('username');
        if (username) {
            const userGreeting = document.getElementById('userGreeting');
            if (userGreeting) {
                userGreeting.textContent = `欢迎，${username}`;
            }
        }
        
        return true;
    } catch (error) {
        console.error('Token验证失败:', error);
        localStorage.removeItem('isLoggedIn');
        localStorage.removeItem('token');
        localStorage.removeItem('username');
        showToast('登录已过期，请重新登录', 'error');
        return false;
    }
}

// 全局变量
let currentPage = 1;
let currentSortBy = 'created_at';
let currentSortOrder = 'desc';
const PAGE_SIZE = 10;
const DEFAULT_COVER_URL = 'https://picsum.photos/id/24/300/400';
const UNIFIED_COVER_MODE = true; // 统一封面风格：根据书籍信息生成封面
let currentFilters = {
    category: [],
    minPrice: '',
    maxPrice: '',
    rating: '',
    search: ''
};
const recoHoverTimers = new Map();
const recoHoverStartedAt = new Map();
let currentDetailBookId = null;
let currentDetailOpenedAt = 0;
let pendingOpenDetailBookId = 0;
let categoryExpanded = false;
let categorySearchKeyword = '';
const CATEGORY_COLLAPSE_COUNT = 8;

function hashSeed(str) {
    let h = 2166136261;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return (h >>> 0);
}

function pickCoverPalette(seed) {
    const palettes = [
        ['#2563EB', '#1D4ED8'],
        ['#7C3AED', '#6D28D9'],
        ['#0F766E', '#0D9488'],
        ['#B45309', '#D97706'],
        ['#BE123C', '#E11D48'],
        ['#374151', '#111827'],
        ['#0EA5E9', '#0369A1'],
        ['#16A34A', '#15803D']
    ];
    return palettes[seed % palettes.length];
}

function getBookSeed(book, fallback = '') {
    return String(
        (book && (book.isbn || `${book.title || ''}-${book.author || ''}`)) ||
        fallback ||
        'book'
    );
}

function buildGeneratedCover(book, fallbackTitle = '') {
    const seedText = getBookSeed(book, fallbackTitle);
    const seed = hashSeed(seedText);
    const [c1, c2] = pickCoverPalette(seed);
    const title = String((book && book.title) || fallbackTitle || '图书').trim();
    const author = String((book && book.author) || '').trim();
    const shortTitle = title.length > 12 ? `${title.slice(0, 12)}...` : title;
    const shortAuthor = author.length > 16 ? `${author.slice(0, 16)}...` : author;
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}" />
      <stop offset="100%" stop-color="${c2}" />
    </linearGradient>
  </defs>
  <rect width="300" height="400" rx="18" fill="url(#g)" />
  <rect x="22" y="20" width="256" height="360" rx="12" fill="rgba(255,255,255,0.08)" />
  <text x="30" y="160" fill="#ffffff" font-size="30" font-weight="700" font-family="Arial, sans-serif">${shortTitle}</text>
  <text x="30" y="205" fill="#e5e7eb" font-size="18" font-family="Arial, sans-serif">${shortAuthor || '未知作者'}</text>
  <text x="30" y="350" fill="#dbeafe" font-size="16" font-family="Arial, sans-serif">Book Cover</text>
</svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function getBookCoverSrc(book) {
    if (UNIFIED_COVER_MODE) {
        return buildGeneratedCover(book, '图书');
    }
    const raw = String((book && book.cover_url) || '').trim();
    return raw || DEFAULT_COVER_URL;
}

function handleBookCoverError(img) {
    if (!img) return;
    if (img.dataset.fallbackApplied === '1') {
        img.src = DEFAULT_COVER_URL;
        return;
    }
    img.dataset.fallbackApplied = '1';
    const title = img.getAttribute('alt') || '图书';
    const seed = img.dataset.seed || title;
    img.src = buildGeneratedCover({ title, author: '', isbn: seed }, title);
}

async function trackRecoEvent(bookId, eventType, eventValue) {
    try {
        const token = localStorage.getItem('token');
        if (!token || !bookId || !eventType) return;
        await fetch('http://localhost:3001/api/reco/event', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                book_id: Number(bookId),
                event_type: String(eventType),
                event_value: eventValue == null ? 1 : Number(eventValue),
                scene: 'bookstore'
            })
        });
    } catch (e) {
        console.warn('图书商店推荐事件上报失败:', e);
    }
}

// 页面加载完成后执行
document.addEventListener('DOMContentLoaded', function() {
    // 检查登录状态
    checkLoginStatus();
    
    // 初始化页面
    initPage();
    
    // 视图切换功能
    const gridViewBtn = document.getElementById('gridViewBtn');
    const listViewBtn = document.getElementById('listViewBtn');
    const bookGrid = document.getElementById('bookGrid');
    const bookList = document.getElementById('bookList');
    
    if (gridViewBtn && listViewBtn && bookGrid && bookList) {
        gridViewBtn.addEventListener('click', function() {
            gridViewBtn.classList.add('active');
            listViewBtn.classList.remove('active');
            bookGrid.style.display = 'grid';
            bookList.style.display = 'none';
        });
        
        listViewBtn.addEventListener('click', function() {
            listViewBtn.classList.add('active');
            gridViewBtn.classList.remove('active');
            bookList.style.display = 'flex';
            bookGrid.style.display = 'none';
        });
    }
    
    // 排序选项点击事件
    const sortOptions = document.querySelectorAll('.sort-option');
    sortOptions.forEach(option => {
        option.addEventListener('click', function() {
            sortOptions.forEach(o => o.classList.remove('active'));
            this.classList.add('active');
            
            // 设置排序方式
            const sortText = this.textContent;
            switch(sortText) {
                case '综合排序':
                    currentSortBy = 'created_at';
                    currentSortOrder = 'desc';
                    break;
                case '销量优先':
                    currentSortBy = 'sales';
                    currentSortOrder = 'desc';
                    break;
                case '价格从高到低':
                    currentSortBy = 'price';
                    currentSortOrder = 'desc';
                    break;
                case '价格从低到高':
                    currentSortBy = 'price';
                    currentSortOrder = 'asc';
                    break;
                case '评分最高':
                    currentSortBy = 'rating';
                    currentSortOrder = 'desc';
                    break;
            }
            
            // 重新获取图书列表
            getBooks();
        });
    });
    
    // 加入购物车按钮点击事件（使用事件委托）
    document.addEventListener('click', function(e) {
        if (e.target.classList.contains('add-to-cart-btn')) {
            // 获取图书信息
            const bookCard = e.target.closest('.book-card');
            const bookListItem = e.target.closest('.book-list-item');
            let bookInfo = null;
            
            if (bookCard) {
                bookInfo = {
                    title: bookCard.querySelector('.book-title').textContent,
                    author: bookCard.querySelector('.book-author').textContent,
                    price: parseFloat(bookCard.querySelector('.book-price').textContent.replace('¥', '')),
                    cover_url: bookCard.querySelector('.book-cover').src
                };
            } else if (bookListItem) {
                bookInfo = {
                    title: bookListItem.querySelector('.book-list-title').textContent,
                    author: bookListItem.querySelector('.book-author').textContent,
                    price: parseFloat(bookListItem.querySelector('.book-list-price').textContent.replace('¥', '')),
                    cover_url: bookListItem.querySelector('.book-list-cover').src
                };
            }
            
            if (bookInfo) {
                // 显示确认弹窗
                if (confirm(`确定要将《${bookInfo.title}》加入购物车吗？`)) {
                    // 加入购物车
                    addToCart(bookInfo);
                    showToast('商品已成功加入购物车！', 'success');
                }
            }
        } 
        // 查看详情按钮点击事件
        else if (e.target.classList.contains('view-details-btn')) {
            const bookId = e.target.getAttribute('data-book-id');
            if (bookId) {
                trackRecoEvent(bookId, 'click', 1);
                showBookDetails(bookId);
            }
        }
        // 关闭模态框按钮点击事件
        else if (e.target.classList.contains('close-modal')) {
            closeBookDetailsModal();
        }
        // 从模态框加入购物车
        else if (e.target.id === 'addToCartFromModal') {
            const modal = document.getElementById('bookDetailsModal');
            const bookInfo = modal.bookInfo;
            if (bookInfo) {
                if (confirm(`确定要将《${bookInfo.title}》加入购物车吗？`)) {
                    addToCart(bookInfo);
                    showToast('商品已成功加入购物车！', 'success');
                }
            }
        }
    });
    
    // 点击模态框外部关闭模态框
    window.addEventListener('click', function(e) {
        const modal = document.getElementById('bookDetailsModal');
        if (e.target === modal) {
            closeBookDetailsModal();
        }
    });
    
    // ESC键关闭模态框
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            const modal = document.getElementById('bookDetailsModal');
            if (modal.style.display === 'flex') {
                closeBookDetailsModal();
            }
        }
    });
    
    // 添加到购物车
    function addToCart(book) {
        // 从本地存储获取购物车数据
        let cart = JSON.parse(localStorage.getItem('cart')) || [];
        
        // 检查商品是否已在购物车中
        const existingBookIndex = cart.findIndex(item => item.title === book.title);
        
        if (existingBookIndex !== -1) {
            // 已存在，数量+1
            cart[existingBookIndex].quantity += 1;
        } else {
            // 不存在，添加新商品
            cart.push({
                ...book,
                quantity: 1
            });
        }
        
        // 保存到本地存储
        localStorage.setItem('cart', JSON.stringify(cart));
    }
    
    // 搜索功能
    const searchInput = document.querySelector('.search-input');
    const searchBoxBtn = document.querySelector('.search-box-btn');
    const searchBtn = document.getElementById('searchBtn');
    
    // 搜索按钮点击事件
    if (searchBoxBtn) {
        searchBoxBtn.addEventListener('click', performSearch);
    }
    if (searchBtn) {
        searchBtn.addEventListener('click', performSearch);
    }
    
    // 搜索框回车事件
    if (searchInput) {
        searchInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                performSearch();
            }
        });
    }
    
    // 筛选按钮事件
    const filterBtn = document.querySelector('.filter-btn');
    const resetBtn = document.querySelector('.reset-btn');
    
    if (filterBtn) {
        filterBtn.addEventListener('click', applyFilters);
    }
    
    if (resetBtn) {
        resetBtn.addEventListener('click', resetFilters);
    }
});

// 初始化页面
function initPage() {
    applyEntryQueryParams();
    setupCategorySearch();
    loadCategoryFilters();
    loadRatingFilters();
    // 获取图书列表
    getBooks();
}

function setupCategorySearch() {
    const input = document.getElementById('categorySearchInput');
    if (!input) return;
    input.addEventListener('input', () => {
        categorySearchKeyword = String(input.value || '').trim().toLowerCase();
        applyCategoryCollapse();
    });
}

async function loadCategoryFilters() {
    const listEl = document.getElementById('categoryFilterList');
    const toggleBtn = document.getElementById('categoryToggleBtn');
    if (!listEl) return;
    try {
        const response = await fetch('http://localhost:3001/api/books/category-stats');
        const data = await response.json();
        if (!response.ok || !data.success || !Array.isArray(data.categories)) {
            throw new Error((data && data.message) || '获取分类失败');
        }
        if (data.categories.length === 0) {
            listEl.innerHTML = '<div class="filter-label">暂无分类数据</div>';
            if (toggleBtn) toggleBtn.style.display = 'none';
            return;
        }
        listEl.innerHTML = '';
        data.categories.forEach(item => {
            const categoryName = String(item.category || '').trim();
            const count = Number(item.count || 0);
            if (!categoryName) return;
            const label = document.createElement('label');
            label.className = 'filter-label';
            const checked = currentFilters.category.includes(categoryName) ? 'checked' : '';
            label.innerHTML = `
                <input type="checkbox" class="filter-checkbox" value="${categoryName}" ${checked}>
                ${categoryName} (${count})
            `;
            listEl.appendChild(label);
        });

        const labels = Array.from(listEl.querySelectorAll('.filter-label'));
        const needCollapse = labels.length > CATEGORY_COLLAPSE_COUNT;
        if (toggleBtn) {
            toggleBtn.style.display = needCollapse ? 'inline-block' : 'none';
            toggleBtn.textContent = categoryExpanded ? '收起' : '展开更多';
            toggleBtn.onclick = () => {
                categoryExpanded = !categoryExpanded;
                applyCategoryCollapse();
            };
        }
        applyCategoryCollapse();
    } catch (error) {
        console.error('加载分类筛选失败:', error);
        listEl.innerHTML = '<div class="filter-label">分类加载失败</div>';
        if (toggleBtn) toggleBtn.style.display = 'none';
    }
}

function applyCategoryCollapse() {
    const listEl = document.getElementById('categoryFilterList');
    const toggleBtn = document.getElementById('categoryToggleBtn');
    if (!listEl) return;
    const labels = Array.from(listEl.querySelectorAll('.filter-label'));
    const visibleBySearch = labels.filter(label => {
        const txt = String(label.textContent || '').toLowerCase();
        return txt.includes(categorySearchKeyword);
    });
    labels.forEach(label => {
        const txt = String(label.textContent || '').toLowerCase();
        const match = txt.includes(categorySearchKeyword);
        label.style.display = match ? 'block' : 'none';
    });
    visibleBySearch.forEach((label, index) => {
        if (!(index < CATEGORY_COLLAPSE_COUNT || categoryExpanded)) {
            label.style.display = 'none';
        }
    });
    if (toggleBtn) {
        const needCollapse = visibleBySearch.length > CATEGORY_COLLAPSE_COUNT;
        toggleBtn.style.display = needCollapse ? 'inline-block' : 'none';
        toggleBtn.textContent = categoryExpanded ? '收起' : '展开更多';
    }
}

async function loadRatingFilters() {
    const listEl = document.getElementById('ratingFilterList');
    if (!listEl) return;
    try {
        const response = await fetch('http://localhost:3001/api/books/rating-stats');
        const data = await response.json();
        if (!response.ok || !data.success || !Array.isArray(data.ratings)) {
            throw new Error((data && data.message) || '获取评分统计失败');
        }
        if (data.ratings.length === 0) {
            listEl.innerHTML = '<div class="filter-label">暂无评分数据</div>';
            return;
        }
        listEl.innerHTML = '';
        data.ratings.forEach(item => {
            const threshold = Number(item.threshold || 0);
            const count = Number(item.count || 0);
            const label = document.createElement('label');
            label.className = 'filter-label';
            const checked = String(currentFilters.rating || '') === String(threshold) ? 'checked' : '';
            label.innerHTML = `
                <input type="checkbox" class="filter-checkbox" value="${threshold}" ${checked}>
                ${threshold.toFixed(1)}分以上 (${count})
            `;
            listEl.appendChild(label);
        });
    } catch (error) {
        console.error('加载评分筛选失败:', error);
        listEl.innerHTML = '<div class="filter-label">评分加载失败</div>';
    }
}

function applyEntryQueryParams() {
    const params = new URLSearchParams(window.location.search || '');
    const qSearch = String(params.get('search') || '').trim();
    const qBookId = Number(params.get('book_id') || 0);
    if (qSearch) {
        currentFilters.search = qSearch;
        const searchInput = document.querySelector('.search-input');
        if (searchInput) searchInput.value = qSearch;
    }
    if (qBookId > 0) {
        pendingOpenDetailBookId = qBookId;
    }
}

// 获取图书列表
async function getBooks() {
    try {
        const params = new URLSearchParams();
        params.append('page', currentPage);
        params.append('limit', PAGE_SIZE);
        params.append('sortBy', currentSortBy);
        params.append('sortOrder', currentSortOrder);
        
        // 添加筛选参数
        if (currentFilters.minPrice) {
            params.append('minPrice', currentFilters.minPrice);
        }
        if (currentFilters.maxPrice) {
            params.append('maxPrice', currentFilters.maxPrice);
        }
        if (currentFilters.rating) {
            params.append('rating', currentFilters.rating);
        }
        if (currentFilters.search) {
            params.append('search', currentFilters.search);
        }
        // 处理分类筛选（暂时只支持单个分类）
        if (currentFilters.category && currentFilters.category.length > 0) {
            params.append('category', currentFilters.category[0]);
        }
        
        const response = await fetch(`http://localhost:3001/api/books?${params}`);
        const data = await response.json();
        
        if (data.success) {
            renderBooks(data.books);
            updatePagination(data.total, data.currentPage, data.totalPages);
            if (pendingOpenDetailBookId > 0) {
                const targetId = pendingOpenDetailBookId;
                pendingOpenDetailBookId = 0;
                showBookDetails(targetId);
            }
        } else {
            showToast('获取图书列表失败', 'error');
        }
    } catch (error) {
        console.error('获取图书列表失败:', error);
        showToast('网络错误，请稍后再试', 'error');
    }
}

// 渲染图书列表
function renderBooks(books) {
    const bookGrid = document.getElementById('bookGrid');
    const bookList = document.getElementById('bookList');
    
    if (!bookGrid || !bookList) return;
    
    // 清空现有内容
    bookGrid.innerHTML = '';
    bookList.innerHTML = '';
    
    // 渲染网格视图
    books.forEach(book => {
        const cover = getBookCoverSrc(book);
        const safeTitle = String(book.title || '');
        const safeSeed = getBookSeed(book, safeTitle);
        // 网格视图卡片
        const gridCard = document.createElement('div');
        gridCard.className = 'book-card';
        gridCard.dataset.bookId = String(book.id);
        gridCard.innerHTML = `
            <img src="${cover}" alt="${safeTitle}" class="book-cover" loading="lazy" referrerpolicy="no-referrer"
                 data-seed="${safeSeed}" onerror="handleBookCoverError(this)">
            <div class="book-info">
                <h3 class="book-title">${book.title}</h3>
                <p class="book-author">${book.author}</p>
                <p class="book-meta">${book.category} | ${book.pages || 0}页 | ${book.rating || 0}分</p>
                <div class="book-price">¥${book.price.toFixed(2)}</div>
                <div class="book-actions">
                    <button class="add-to-cart-btn">加入购物车</button>
                    <button class="view-details-btn" data-book-id="${book.id}">查看详情</button>
                </div>
            </div>
        `;
        bindRecoHoverDwell(gridCard, book.id);
        bookGrid.appendChild(gridCard);
        
        // 列表视图项
        const listItem = document.createElement('div');
        listItem.className = 'book-list-item';
        listItem.dataset.bookId = String(book.id);
        listItem.innerHTML = `
            <img src="${cover}" alt="${safeTitle}" class="book-list-cover" loading="lazy" referrerpolicy="no-referrer"
                 data-seed="${safeSeed}" onerror="handleBookCoverError(this)">
            <div class="book-list-info">
                <h3 class="book-list-title">${book.title}</h3>
                <p class="book-author">${book.author}</p>
                <p class="book-list-desc">${book.description || '暂无描述'}</p>
                <div class="book-list-actions">
                    <div class="book-list-price">¥${book.price.toFixed(2)}</div>
                    <button class="view-details-btn" data-book-id="${book.id}">查看详情</button>
                    <button class="add-to-cart-btn">加入购物车</button>
                </div>
            </div>
        `;
        bindRecoHoverDwell(listItem, book.id);
        bookList.appendChild(listItem);
    });
}

function bindRecoHoverDwell(el, bookId) {
    const id = Number(bookId);
    if (!id || !el) return;
    el.addEventListener('mouseenter', () => {
        if (recoHoverTimers.has(id)) return;
        const timer = setTimeout(() => {
            recoHoverStartedAt.set(id, Date.now());
            trackRecoEvent(id, 'impression', 1);
        }, 1200);
        recoHoverTimers.set(id, timer);
    });
    el.addEventListener('mouseleave', () => {
        const timer = recoHoverTimers.get(id);
        if (timer) {
            clearTimeout(timer);
            recoHoverTimers.delete(id);
        }
        const started = recoHoverStartedAt.get(id);
        if (started) {
            const sec = Math.max(0, (Date.now() - started) / 1000);
            if (sec >= 1.2) {
                trackRecoEvent(id, 'dwell', Math.min(2, sec / 12));
            }
            recoHoverStartedAt.delete(id);
        }
    });
}

// 获取图书详情
async function getBookDetails(bookId) {
    try {
        const response = await fetch(`http://localhost:3001/api/books/${bookId}`);
        const data = await response.json();
        
        if (data.success) {
            return data.book;
        } else {
            showToast('获取图书详情失败', 'error');
            return null;
        }
    } catch (error) {
        console.error('获取图书详情失败:', error);
        showToast('网络错误，请稍后再试', 'error');
        return null;
    }
}

// 显示图书详情模态框
async function showBookDetails(bookId) {
    const book = await getBookDetails(bookId);
    if (!book) return;
    
    // 填充模态框内容
    const modalCover = document.getElementById('modalBookCover');
    modalCover.referrerPolicy = 'no-referrer';
    modalCover.dataset.seed = getBookSeed(book, book.title || '图书');
    modalCover.onerror = function onCoverErr() {
        handleBookCoverError(this);
    };
    modalCover.src = getBookCoverSrc(book);
    document.getElementById('modalBookTitle').textContent = book.title;
    document.getElementById('modalBookAuthor').textContent = `作者：${book.author}`;
    document.getElementById('modalBookMeta').textContent = `${book.category} | ${book.rating || 0}分`;
    document.getElementById('modalBookPublisher').textContent = `出版社：${book.publisher || '未知出版社'}`;
    document.getElementById('modalBookPublishDate').textContent = `出版日期：${book.publish_date || '未知日期'}`;
    document.getElementById('modalBookPages').textContent = `页数：${book.pages || 0}页`;
    document.getElementById('modalBookPrice').innerHTML = `<strong>¥${book.price.toFixed(2)}</strong>`;
    document.getElementById('modalBookDescription').textContent = book.description || '暂无描述';
    
    // 存储当前图书信息到模态框元素中，以便加入购物车时使用
    const modal = document.getElementById('bookDetailsModal');
    modal.bookInfo = book;
    
    // 显示模态框
    modal.style.display = 'flex';
    currentDetailBookId = Number(bookId);
    currentDetailOpenedAt = Date.now();
    trackRecoEvent(bookId, 'detail', 1);
}

// 关闭图书详情模态框
function closeBookDetailsModal() {
    const modal = document.getElementById('bookDetailsModal');
    modal.style.display = 'none';
    if (currentDetailBookId && currentDetailOpenedAt > 0) {
        const sec = Math.max(0, (Date.now() - currentDetailOpenedAt) / 1000);
        if (sec >= 1) {
            trackRecoEvent(currentDetailBookId, 'dwell', Math.min(2, sec / 15));
        }
    }
    currentDetailBookId = null;
    currentDetailOpenedAt = 0;
    // 清空存储的图书信息
    modal.bookInfo = null;
}

// 更新分页
function updatePagination(total, currentPageNum, totalPages) {
    const pagination = document.querySelector('.pagination');
    if (!pagination) return;

    const totalSafe = Number(total || 0);
    const pagesSafe = Math.max(1, Number(totalPages || 1));
    const currentSafe = Math.min(Math.max(1, Number(currentPageNum || 1)), pagesSafe);

    pagination.innerHTML = '';

    const makeBtn = (label, page, disabled = false, active = false) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pagination-btn';
        if (active) btn.classList.add('active');
        btn.textContent = label;
        btn.disabled = disabled;
        if (!disabled) {
            btn.addEventListener('click', () => {
                if (currentPage === page) return;
                currentPage = page;
                getBooks();
            });
        }
        return btn;
    };

    pagination.appendChild(makeBtn('上一页', currentSafe - 1, currentSafe <= 1));

    const maxShow = 7;
    let start = Math.max(1, currentSafe - Math.floor(maxShow / 2));
    let end = Math.min(pagesSafe, start + maxShow - 1);
    start = Math.max(1, end - maxShow + 1);

    if (start > 1) {
        pagination.appendChild(makeBtn('1', 1, false, currentSafe === 1));
        if (start > 2) {
            const dots = document.createElement('span');
            dots.className = 'pagination-dots';
            dots.textContent = '...';
            pagination.appendChild(dots);
        }
    }

    for (let p = start; p <= end; p++) {
        pagination.appendChild(makeBtn(String(p), p, false, p === currentSafe));
    }

    if (end < pagesSafe) {
        if (end < pagesSafe - 1) {
            const dots = document.createElement('span');
            dots.className = 'pagination-dots';
            dots.textContent = '...';
            pagination.appendChild(dots);
        }
        pagination.appendChild(makeBtn(String(pagesSafe), pagesSafe, false, currentSafe === pagesSafe));
    }

    pagination.appendChild(makeBtn('下一页', currentSafe + 1, currentSafe >= pagesSafe));

    const info = document.createElement('span');
    info.className = 'pagination-info';
    info.textContent = `共 ${totalSafe} 本，${pagesSafe} 页`;
    pagination.appendChild(info);
}

// 执行搜索
function performSearch() {
    const searchInput = document.querySelector('.search-input');
    if (searchInput) {
        currentFilters.search = searchInput.value.trim();
        currentPage = 1; // 搜索时重置到第一页
        getBooks();
    }
}

// 应用筛选
function applyFilters() {
    // 获取分类筛选
    const categoryCheckboxes = document.querySelectorAll('.sidebar-section:nth-child(1) .filter-checkbox:checked');
    currentFilters.category = Array.from(categoryCheckboxes).map(checkbox => String(checkbox.value || '').trim()).filter(Boolean);
    
    // 获取价格筛选
    const priceInputs = document.querySelectorAll('.price-input');
    currentFilters.minPrice = priceInputs[0].value.trim();
    currentFilters.maxPrice = priceInputs[1].value.trim();
    
    // 获取评分筛选
    const ratingCheckboxes = document.querySelectorAll('.sidebar-section:nth-child(3) .filter-checkbox:checked');
    if (ratingCheckboxes.length > 0) {
        currentFilters.rating = String(ratingCheckboxes[0].value || '').trim();
    } else {
        currentFilters.rating = '';
    }
    
    currentPage = 1; // 筛选时重置到第一页
    getBooks();
    showToast('筛选已应用', 'success');
}

// 重置筛选
function resetFilters() {
    // 重置分类筛选
    const categoryCheckboxes = document.querySelectorAll('.sidebar-section:nth-child(1) .filter-checkbox');
    categoryCheckboxes.forEach(checkbox => checkbox.checked = false);
    
    // 重置价格筛选
    const priceInputs = document.querySelectorAll('.price-input');
    priceInputs.forEach(input => input.value = '');
    
    // 重置评分筛选
    const ratingCheckboxes = document.querySelectorAll('.sidebar-section:nth-child(3) .filter-checkbox');
    ratingCheckboxes.forEach(checkbox => checkbox.checked = false);
    
    // 重置搜索框
    const searchInput = document.querySelector('.search-input');
    if (searchInput) {
        searchInput.value = '';
    }
    
    // 重置筛选条件
    currentFilters = {
        category: [],
        minPrice: '',
        maxPrice: '',
        rating: '',
        search: ''
    };
    
    currentPage = 1; // 重置到第一页
    getBooks();
    showToast('筛选已重置', 'success');
}
