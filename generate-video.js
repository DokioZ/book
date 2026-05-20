// 视频生成主函数
function generateVideo() {
    // 确保window.videoSystemState已定义
    if (typeof window.videoSystemState === 'undefined') {
        window.videoSystemState = {
            sdkLoaded: false,
            sdkInitialized: false,
            webChatClient: null,
            loadingAttempts: 0,
            maxAttempts: 8,
            isGenerating: false,
            videoUrl: null,
            space_id: '7545798611513196554',
            workflow_id: '7633714095825600546',
            bot_id: '7545799369434677294',
            isDemoMode: false,
            currentTaskId: null,
            foundValidData: false,
            lastWorkflowResponse: null,
            generationTimeout: null // 添加超时计时器引用
        };
    } else if (typeof window.videoSystemState.foundValidData === 'undefined') {
        window.videoSystemState.foundValidData = false;
    }
    // 确保generationTimeout属性存在
    if (typeof window.videoSystemState.generationTimeout === 'undefined') {
        window.videoSystemState.generationTimeout = null;
    }
    // 清除之前可能存在的超时计时器
    if (window.videoSystemState.generationTimeout) {
        clearTimeout(window.videoSystemState.generationTimeout);
        window.videoSystemState.generationTimeout = null;
    }

    const bookName = document.getElementById('bookName').value.trim();
    const authorName = (document.getElementById('authorName')?.value || '').trim();
    const ipName = (document.getElementById('ipName')?.value || '').trim();
    const bookContent = document.getElementById('bookContent').value.trim();

    // 验证输入
    if (!bookName) {
        showToast('请输入图书名称', 'error');
        return;
    }
    if (!authorName) {
        showToast('请输入作者名称', 'error');
        return;
    }
    if (!ipName) {
        showToast('请输入IP名称', 'error');
        return;
    }

    // 获取DOM元素
    const generateBtn = document.getElementById('generateBtn');

    // 更新UI状态
    if (generateBtn) {
        generateBtn.disabled = true;
        generateBtn.style.opacity = '0.7';
    }

    // 更新视频系统状态
    window.videoSystemState.isGenerating = true;

    // 添加全局超时机制，防止UI永久卡住
    window.videoSystemState.generationTimeout = setTimeout(() => {
        if (window.videoSystemState && window.videoSystemState.isGenerating) {
            console.error('JSON数据获取超时，自动重置UI状态');
            showToast('JSON数据获取超时，请稍后重试', 'error');
            resetUIState();
        }
    }, 180000); // 180秒超时，与API请求超时保持一致

    // 启动工作流JSON数据获取过程
    handleVideoGeneration().catch(error => {
        console.error('获取工作流JSON数据过程中发生异常:', error);
        showToast('获取工作流JSON数据时发生异常: ' + error.message, 'error');
        resetUIState();
        clearGenerationTimeout();
    }).then(success => {
        if (success === false) {
            resetUIState();
        } else {
            // JSON数据获取成功，更新生成按钮状态
            if (generateBtn) {
                generateBtn.disabled = false;
                generateBtn.style.opacity = '1';
            }
            window.videoSystemState.isGenerating = false;
        }
        clearGenerationTimeout();
    });
}

// 清除视频生成超时计时器
function clearGenerationTimeout() {
    if (window.videoSystemState && window.videoSystemState.generationTimeout) {
        clearTimeout(window.videoSystemState.generationTimeout);
        window.videoSystemState.generationTimeout = null;
    }
}

// 重置UI状态函数
function resetUIState() {
    const generateBtn = document.getElementById('generateBtn');
    
    // 清除所有计时器
    clearGenerationTimeout();
    
    // 重置isGenerating状态
    if (window.videoSystemState) {
        window.videoSystemState.isGenerating = false;
    }
    
    // 启用生成按钮并恢复透明度
    if (generateBtn) {
        generateBtn.disabled = false;
        generateBtn.style.opacity = '1';
    }
    
    console.log('UI状态已成功重置');
}

// 处理JSON生成的异步函数
async function handleVideoGeneration() {
    try {
        // 开始处理JSON数据...
        console.log('开始处理JSON数据...');
        
        // 确保window.videoSystemState已定义
        if (typeof window.videoSystemState === 'undefined') {
            window.videoSystemState = {}
        }
        
        // 记录开始时间
        window.videoSystemState.startTime = Date.now();
        
        // 获取图书信息
        const bookName = document.getElementById('bookName').value.trim();
        const authorName = (document.getElementById('authorName')?.value || '').trim();
        const ipName = (document.getElementById('ipName')?.value || '').trim();
        if (!bookName || !authorName || !ipName) {
            throw new Error('请完整填写书名、作者名和IP名');
        }
        const bookInfo = {
            title: bookName,
            author: authorName,
            ipName: ipName,
            content: bookContent || '暂无内容'
        };
        
        // 获取工作流返回的JSON数据
        const workflowJson = await getWorkflowJsonResponse();
        
        // 保存JSON数据到系统状态
        window.videoSystemState.lastWorkflowJson = workflowJson;
        
        // 清除超时计时器，避免UI被自动重置
        clearGenerationTimeout();
        
        // 显示JSON已成功获取的提示
        showToast('工作流JSON数据获取完成！', 'success');
        
        // 保存原始的工作流生成地址（如果有）
        let originalWorkflowUrl = null;
        if (workflowJson?.data && typeof workflowJson.data === 'string') {
            // 尝试从data字段中提取URL
            const urlMatch = workflowJson.data.match(/https?:\/\/[^\s,"]+/);
            if (urlMatch) {
                // 清理可能的后缀字符，去掉末尾的下划线
                originalWorkflowUrl = urlMatch[0].replace(/["']$/, '').replace(/_+$/, '');
            }
        } else if (workflowJson?.result?.content && typeof workflowJson.result.content === 'string') {
            // 尝试从result.content字段中提取URL
            const urlMatch = workflowJson.result.content.match(/https?:\/\/[^\s,"]+/);
            if (urlMatch) {
                // 清理可能的后缀字符，去掉末尾的下划线
                originalWorkflowUrl = urlMatch[0].replace(/["']$/, '').replace(/_+$/, '');
            }
        }
        
        console.log('工作流生成的JSON地址:', originalWorkflowUrl || '未找到');
        
        // 只显示工作流返回的原始地址
        showJsonInfo(workflowJson, originalWorkflowUrl);
        
        // 成功完成，不进行任何视频处理
        return true;
    } catch (error) {
        console.error('处理过程中发生异常:', error);
        showToast('处理数据时发生异常: ' + error.message, 'error');
        resetUIState();
        clearGenerationTimeout(); // 发生错误时也清除超时计时器
        return false;
    }
}

// 获取工作流返回的JSON数据
async function getWorkflowJsonResponse() {
    try {
        console.log('获取工作流返回的JSON数据...');
        
        // 获取用户Token
        const userToken = localStorage.getItem('token');
        if (!userToken) {
            showToast('用户未登录，无法调用视频生成服务', 'error');
            throw new Error('用户未登录');
        }
        
        // 获取图书信息
        const bookName = document.getElementById('bookName').value.trim();
        const authorName = (document.getElementById('authorName')?.value || '').trim();
        const ipName = (document.getElementById('ipName')?.value || '').trim();
        const bookContent = document.getElementById('bookContent').value.trim();
        
        // 准备API参数 - 包含workflow_id并使用params字段封装图书信息
        const workflowParams = {
            workflow_id: window.videoSystemState.workflow_id,
            params: {
                book_name: bookName,
                author_name: authorName,
                ip_name: ipName
            }
        };
        
        console.log('====== 工作流调用调试信息 ======');
        console.log('传递的参数:', workflowParams.params);
        
        // 使用正确的API路径 - 服务器端定义的是/api/coze/workflow/invoke
        const response = await fetch('/api/coze/workflow/invoke', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userToken}`
            },
            body: JSON.stringify(workflowParams)
        });
        
        if (!response.ok) {
            let errorMessage = `工作流API调用失败，状态码: ${response.status}`;
            try {
                const errorData = await response.json();
                if (errorData.message) errorMessage = errorData.message;
                else if (errorData.error && errorData.error.msg) errorMessage = errorData.error.msg;
                else if (errorData.error) errorMessage = JSON.stringify(errorData.error);
                else if (errorData.msg) errorMessage = errorData.msg;
            } catch (jsonError) {
                // 忽略JSON解析错误
            }
            throw new Error(errorMessage);
        }
        
        const workflowJson = await response.json();
        console.log('工作流JSON数据:', workflowJson);
        
        // 保存工作流响应到系统状态
        window.videoSystemState.lastWorkflowResponse = workflowJson;
        
        return workflowJson;
    } catch (error) {
        console.error('获取工作流JSON数据失败:', error);
        throw error;
    }
}

// 使用即梦AI处理工作流返回的JSON数据
async function processJsonWithJiemengAI(jsonContent, bookInfo) {
    try {
        console.log('使用即梦AI处理工作流返回的JSON数据:', jsonContent);
        
        // 尝试从JSON数据中提取草稿URL
        const draftUrl = extractDraftUrlFromWorkflowJson(jsonContent);
        
        // 如果没有提取到草稿URL，尝试直接使用Coze数据（可能是标准格式）
        if (!draftUrl) {
            console.log('未提取到草稿URL，尝试直接使用Coze数据格式');
            try {
                // 转换Coze数据为即梦AI所需的格式
                const jimengPayload = transformCozeToJimengFormat(jsonContent);
                
                console.log('转换后的即梦AI数据格式:', jimengPayload);
                
                // 直接调用我们修改过的callJiemengAI函数，传入转换后的格式
                // 这里我们传入转换后的对象作为draftUrl参数，callJiemengAI函数会识别并正确处理
                const videoUrl = await callJiemengAI(jimengPayload, bookInfo);
                
                return videoUrl;
            } catch (error) {
                console.error('直接处理Coze数据失败:', error);
                throw new Error('无法从工作流JSON中提取必要的视频信息，且直接处理Coze数据失败');
            }
        }
        
        console.log('提取到的草稿地址:', draftUrl);
        
        // 调用即梦AI API生成视频
        const videoUrl = await callJiemengAI(draftUrl, bookInfo);
        
        return videoUrl;
    } catch (error) {
        console.error('使用即梦AI处理JSON数据失败:', error);
        throw error;
    }
}

// 数据格式转换函数 - 将Coze数据转换为即梦AI所需的格式
function transformCozeToJimengFormat(cozeData) {
    try {
        console.log('转换Coze数据为即梦AI格式:', cozeData);
        
        // 处理可能的嵌套JSON结构
        let normalizedData = cozeData;
        if (typeof cozeData === 'string') {
            try {
                normalizedData = JSON.parse(cozeData);
            } catch (e) {
                console.warn('Coze数据不是有效的JSON字符串，尝试直接使用:', e);
            }
        }
        
        // 从不同可能的位置提取视频生成所需的数据
        let script = '';
        let sceneDescriptions = [];
        let voiceSettings = {};
        let visualStyle = 'general';
        let backgroundMusic = 'none';
        
        // 优先从标准字段提取数据
        if (normalizedData?.script) {
            script = normalizedData.script;
        }
        
        if (normalizedData?.scene_descriptions) {
            sceneDescriptions = Array.isArray(normalizedData.scene_descriptions) 
                ? normalizedData.scene_descriptions 
                : [normalizedData.scene_descriptions];
        }
        
        if (normalizedData?.voice_settings) {
            voiceSettings = normalizedData.voice_settings;
        }
        
        if (normalizedData?.visual_style) {
            visualStyle = normalizedData.visual_style;
        }
        
        if (normalizedData?.background_music) {
            backgroundMusic = normalizedData.background_music;
        }
        
        // 尝试从其他可能的位置提取数据
        if (!script) {
            const possibleScriptFields = [
                normalizedData?.data?.script,
                normalizedData?.result?.script,
                normalizedData?.content
            ];
            
            for (const field of possibleScriptFields) {
                if (field && typeof field === 'string') {
                    script = field;
                    break;
                }
            }
        }
        
        // 如果仍然没有脚本内容，设置默认值
        if (!script) {
            script = '这是一个自动生成的图书介绍视频';
        }
        
        // 如果没有场景描述，创建默认场景
        if (sceneDescriptions.length === 0) {
            sceneDescriptions = [script.substring(0, 100) + (script.length > 100 ? '...' : '')];
        }
        
        // 构建即梦AI所需的格式
        const jimengPayload = {
            "script": script,
            "scenes": sceneDescriptions.map((desc, index) => ({
                "scene_number": index + 1,
                "description": desc,
                "duration": 5 // 默认每个场景5秒
            })),
            "voice_config": {
                "voice_type": voiceSettings?.voice_type || "default",
                "speed": voiceSettings?.speed || 1.0
            },
            "style": visualStyle,
            "background_music": backgroundMusic,
            "output_format": "mp4",
            "resolution": "1080p"
        };
        
        console.log('转换后的即梦AI请求数据:', jimengPayload);
        return jimengPayload;
    } catch (error) {
        console.error('转换Coze数据格式失败:', error);
        throw error;
    }
}

// 从工作流JSON中提取草稿地址并转换为速推AIGC平台格式
function extractDraftUrlFromWorkflowJson(jsonContent) {
    try {
        // 尝试从不同位置提取草稿地址
        let draftUrl = null;
        
        console.log('正在解析的工作流JSON数据:', jsonContent);
        
        // 首先检查jsonContent.data是否为字符串（根据控制台日志中的格式）
        if (jsonContent?.data && typeof jsonContent.data === 'string') {
            console.log('检测到data为字符串格式，尝试解析:', jsonContent.data);
            
            // 检查字符串中是否包含URL - 优先使用这种简单可靠的方式
            if (jsonContent.data.includes('http')) {
                // 简单提取URL的方法
                const urlMatch = jsonContent.data.match(/https?:\/\/[^\s,"]+/);
                if (urlMatch && urlMatch[0]) {
                    // 清理可能的后缀字符，去掉末尾的下划线
                    draftUrl = urlMatch[0].replace(/["']$/, '').replace(/_+$/, '');
                    console.log('从字符串data中提取到URL:', draftUrl);
                }
            }
            
            // 如果没有找到URL，尝试解析字符串中的JSON部分（改进的错误处理）
            if (!draftUrl) {
                try {
                    // 改进的JSON提取方法 - 查找完整的JSON对象
                    const cleanJsonStr = jsonContent.data.trim();
                    let startIndex = cleanJsonStr.indexOf('{');
                    let endIndex = cleanJsonStr.lastIndexOf('}');
                    
                    if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
                        const jsonStr = cleanJsonStr.substring(startIndex, endIndex + 1);
                        try {
                            const embeddedJson = JSON.parse(jsonStr);
                            console.log('解析到嵌入的JSON:', embeddedJson);
                            
                            // 检查嵌入的JSON中是否包含URL
                            if (embeddedJson?.content && typeof embeddedJson.content === 'string' && embeddedJson.content.includes('http')) {
                                const urlMatch = embeddedJson.content.match(/https?:\/\/[^\s,"]+/);
                                if (urlMatch && urlMatch[0]) {
                                    // 清理可能的后缀字符，去掉末尾的下划线
                                    draftUrl = urlMatch[0].replace(/["']$/, '').replace(/_+$/, '');
                                    console.log('从嵌入的JSON中提取到URL:', draftUrl);
                                }
                            }
                        } catch (jsonError) {
                            console.log('解析提取的JSON片段失败，跳过这种方法:', jsonError);
                            // 继续尝试其他方法
                        }
                    }
                } catch (e) {
                    console.log('尝试解析字符串中的JSON时发生异常:', e);
                    // 继续尝试其他方法
                }
            }
        }
        
        // 检查data.output.content
        if (!draftUrl && jsonContent?.data?.output?.content) {
            try {
                const contentObj = JSON.parse(jsonContent.data.output.content);
                if (contentObj?.node?.nparameters?.content) {
                    draftUrl = contentObj.node.nparameters.content;
                }
            } catch (e) {
                console.log('解析data.output.content失败:', e);
            }
        }
        
        // 检查output字段
        if (!draftUrl && jsonContent?.output && typeof jsonContent.output === 'string') {
            draftUrl = jsonContent.output;
        }
        
        // 检查其他可能的字段
        if (!draftUrl) {
            const contentFields = [
                jsonContent?.content,
                jsonContent?.result?.content,
                jsonContent?.data?.content
            ];
            
            for (const field of contentFields) {
                if (field && typeof field === 'string' && field.includes('http')) {
                    draftUrl = field;
                    break;
                }
            }
        }
        
        // 如果找到了原始JSON地址，将其转换为速推AIGC平台的剪映草稿链接格式
        let finalUrl = draftUrl;
        if (draftUrl && !draftUrl.startsWith('https://ts.fyshark.com/#/cozeToJianyin?drafId=')) {
            // 确保draftUrl是完整的URL，不包含额外的引号或其他字符，去掉末尾的下划线
            const cleanDraftUrl = draftUrl.replace(/["']/g, '').trim().replace(/_+$/, '');
            // 构建完整的速推AIGC平台链接
            finalUrl = `https://ts.fyshark.com/#/cozeToJianyin?drafId=${encodeURIComponent(cleanDraftUrl)}`;
        }
        
        console.log('最终提取并转换的草稿地址:', finalUrl || '未找到');
        return finalUrl;
    } catch (error) {
        console.error('提取草稿地址失败:', error);
        return null;
    }
}

// 调用服务器视频处理API生成视频
async function callJiemengAI(draftUrl, bookInfo) {
    try {
        console.log('调用视频生成API');
        
        // 获取用户Token
        const userToken = localStorage.getItem('token');
        if (!userToken) {
            throw new Error('用户未登录，无法调用视频生成服务');
        }
        
        // 构建API请求参数 - 支持两种格式：
        // 1. 当draftUrl为对象时，表示已经是转换后的Coze数据
        // 2. 当draftUrl为字符串时，表示传统的草稿URL
        let requestData = {};
        
        if (typeof draftUrl === 'object' && draftUrl !== null) {
            // 处理转换后的Coze数据格式
            console.log('处理转换后的Coze数据');
            requestData = draftUrl;
        } else {
            // 处理传统的草稿URL格式
            console.log('处理传统的草稿URL格式');
            requestData = {
                draftUrl: draftUrl,
                content: bookInfo.content,
                title: bookInfo.title
            };
        }
        
        console.log('准备发送到视频API的数据:', requestData);
        
        // 首先尝试使用服务器端代理接口（更可靠，避免DNS解析问题）
        try {
            console.log('首先尝试服务器端代理接口');
            
            // 构建代理接口请求参数
            const proxyRequestData = {
                jsonContent: {
                    draftUrl: draftUrl,
                    content: bookInfo.content,
                    title: bookInfo.title
                },
                bookInfo: bookInfo
            };
            
            const proxyResponse = await fetch('/api/video/process-json', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${userToken}`
                },
                body: JSON.stringify(proxyRequestData)
            });
            
            if (proxyResponse.ok) {
                const proxyResult = await proxyResponse.json();
                
                if (proxyResult.success && proxyResult.taskId) {
                    console.log('视频处理任务通过代理接口已提交，任务ID:', proxyResult.taskId);
                    return `/api/video/task/${proxyResult.taskId}`;
                } else {
                    console.log('代理接口返回非成功结果，准备尝试其他方式');
                }
            } else {
                console.log('代理接口返回非成功状态码，准备尝试其他方式');
            }
        } catch (proxyError) {
            console.log('服务器端代理接口调用失败，准备尝试其他方式:', proxyError);
        }
        
        // 如果代理接口失败，尝试直接使用转换后的数据格式调用可能存在的即梦AI API
        console.log('尝试直接使用转换后的数据格式调用即梦AI API');
        
        // 为了避免DNS解析问题，我们可以设置多个备用端点
        const JIMENG_API_ENDPOINTS = [
            '/api/video/direct-generate', // 假设的本地代理端点
            'https://api.jimeng-ai.com/v1/video/generate', // 原端点
            'https://api.jiemeng-ai.com/v1/video/generate'  // 可能的拼写变体
        ];
        
        // 尝试所有备用端点
        for (const endpoint of JIMENG_API_ENDPOINTS) {
            try {
                console.log(`尝试端点: ${endpoint}`);
                
                const response = await fetchWithRetry(endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${userToken}`
                    },
                    body: JSON.stringify(requestData)
                }, 2, 1000); // 减少重试次数，加快失败检测
                
                if (!response.ok) {
                    console.log(`端点 ${endpoint} 返回非成功状态码: ${response.status}`);
                    continue;
                }
                
                const result = await response.json();
                
                if (result.success && result.data && result.data.taskId) {
                    console.log('视频处理任务已提交，任务ID:', result.data.taskId);
                    return `/api/video/task/${result.data.taskId}`;
                } else if (result.success && result.data && result.data.video_url) {
                    console.log('视频生成成功，直接获取到视频URL:', result.data.video_url);
                    return result.data.video_url;
                } else if (result.success && result.taskId) {
                    // 兼容服务器端代理接口的返回格式
                    console.log('视频处理任务已提交，任务ID:', result.taskId);
                    return `/api/video/task/${result.taskId}`;
                } else if (result.success && result.video_url) {
                    // 兼容服务器端代理接口的返回格式
                    console.log('视频生成成功，直接获取到视频URL:', result.video_url);
                    return result.video_url;
                }
            } catch (error) {
                console.log(`端点 ${endpoint} 调用失败:`, error);
                continue;
            }
        }
        
        // 如果所有方式都失败，抛出友好的错误信息
        throw new Error('视频生成服务暂时不可用，请稍后再试');
    } catch (error) {
        console.error('调用视频生成API失败:', error);
        throw error;
    }
}

// 显示JSON文件地址
function showVideo(url) {
    try {
        const jsonPlaceholder = document.getElementById('jsonPlaceholder');
        const jsonResult = document.getElementById('jsonResult');
        const jsonFileUrl = document.getElementById('jsonFileUrl');
        const progressBar = document.getElementById('videoProgressBar') || document.createElement('div');
        
        // 确保window.videoSystemState已定义
        if (typeof window.videoSystemState === 'undefined') {
            window.videoSystemState = {}
        }
        
        // 更新系统状态，去掉末尾的下划线
        window.videoSystemState.jsonUrl = url ? url.replace(/_+$/, '') : url;
        window.videoSystemState.startTime = Date.now(); // 记录开始时间
        
        // 检查URL是否是视频文件URL（支持多种格式）
        const isVideoUrl = url && (
            url.includes('/api/video/file/') || 
            url.includes('/video/') ||
            url.endsWith('.mp4') || 
            url.endsWith('.mov') || 
            url.endsWith('.avi') ||
            url.endsWith('.mkv') ||
            url.endsWith('.webm') ||
            url.startsWith('http') && (url.includes('video') || url.includes('mp4'))
        );
        
        if (isVideoUrl) {
            // 这是一个视频文件URL，显示视频播放器
            console.log('显示视频播放器:', url);
            
            // 隐藏JSON结果区域
            if (jsonResult) {
                jsonResult.style.display = 'none';
            }
            
            // 显示视频播放器
            if (jsonPlaceholder) {
                jsonPlaceholder.style.display = 'flex';
                jsonPlaceholder.style.flexDirection = 'column';
                jsonPlaceholder.style.alignItems = 'center';
                jsonPlaceholder.style.justifyContent = 'center';
                jsonPlaceholder.style.padding = '20px';
                jsonPlaceholder.innerHTML = `
                    <div style="width: 100%; max-width: 800px; margin: 0 auto;">
                        <h3 style="margin-bottom: 20px; text-align: center; color: #333; font-size: 20px; font-weight: bold;">生成的视频</h3>
                        <div style="position: relative; width: 100%; padding-bottom: 56.25%; background-color: #000; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                            <video controls style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;" preload="metadata">
                                <source src="${url}" type="video/mp4">
                                您的浏览器不支持视频播放。
                            </video>
                        </div>
                        <div style="margin-top: 20px; text-align: center;">
                            <a href="${url}" download style="display: inline-block; padding: 12px 24px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 4px; font-weight: bold; transition: background-color 0.3s;">
                                <i class="fas fa-download"></i> 下载视频
                            </a>
                        </div>
                        <p style="margin-top: 15px; text-align: center; color: #666; font-size: 14px;">视频已成功生成，您可以在线播放或下载</p>
                    </div>
                `;
                
                // 添加视频加载错误处理
                setTimeout(() => {
                    const video = jsonPlaceholder.querySelector('video');
                    if (video) {
                        video.addEventListener('error', function(e) {
                            console.error('视频加载失败:', e);
                            jsonPlaceholder.innerHTML = `
                                <div style="text-align: center; padding: 40px;">
                                    <i class="fas fa-exclamation-triangle" style="color: #ff9800; font-size: 48px; margin-bottom: 20px;"></i>
                                    <p style="font-size: 18px; font-weight: bold; margin-bottom: 10px; color: #333;">视频加载失败</p>
                                    <p style="font-size: 14px; color: #666; margin-bottom: 20px;">视频URL: ${url}</p>
                                    <a href="${url}" download style="display: inline-block; padding: 12px 24px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 4px;">
                                        <i class="fas fa-download"></i> 尝试下载视频
                                    </a>
                                </div>
                            `;
                        });
                        
                        video.addEventListener('loadedmetadata', function() {
                            console.log('视频元数据加载成功，时长:', video.duration, '秒');
                        });
                    }
                }, 100);
            }
            
            if (document.getElementById('videoProgressBar')) {
                document.getElementById('videoProgressBar').style.display = 'none';
            }
            
            console.log('视频已显示:', url);
            
            // 视频生成完成后自动提交到待审核队列
            setTimeout(() => {
              const videoTitle = document.getElementById('bookName')?.value || '生成视频' + new Date().getTime();
              const videoDescription = document.getElementById('bookContent')?.value || '';
              
              // 创建视频对象
              const newVideo = {
                id: 'video-' + Date.now(),
                title: videoTitle,
                description: videoDescription,
                url: url,
                status: 'pending',
                uploadTime: new Date().toISOString(),
                duration: '00:00',
                views: 0,
                likes: 0,
                comments: 0,
                author: localStorage.getItem('username') || '匿名用户'
              };
              
              // 从localStorage获取现有视频列表
              let userVideos = JSON.parse(localStorage.getItem('userVideos') || '[]');
              
              // 添加新视频
              userVideos.push(newVideo);
              
              // 保存更新后的视频列表
              localStorage.setItem('userVideos', JSON.stringify(userVideos));
              
              console.log('视频已自动提交到待审核队列:', newVideo);
              showToast('视频已成功提交审核，请在管理中心查看', 'success');
            }, 1000);
        } else if (url.includes('/api/video/task/')) {
            // 这是一个任务状态查询URL，需要轮询等待处理完成
            console.log('开始轮询任务状态:', url);
            
            // 创建进度条（如果不存在）
            if (!progressBar.id) {
                progressBar.id = 'videoProgressBar';
                progressBar.style.width = '100%';
                progressBar.style.height = '4px';
                progressBar.style.backgroundColor = '#f0f0f0';
                progressBar.style.borderRadius = '2px';
                progressBar.style.overflow = 'hidden';
                progressBar.style.marginBottom = '10px';
                
                const progressFill = document.createElement('div');
                progressFill.id = 'videoProgressFill';
                progressFill.style.width = '0%';
                progressFill.style.height = '100%';
                progressFill.style.backgroundColor = '#4CAF50';
                progressFill.style.transition = 'width 0.3s ease';
                
                progressBar.appendChild(progressFill);
                
                if (jsonPlaceholder && jsonPlaceholder.parentNode) {
                    jsonPlaceholder.parentNode.insertBefore(progressBar, jsonPlaceholder);
                }
            } else {
                progressBar.style.display = 'block';
            }
            
            // 显示加载状态
            if (jsonPlaceholder) {
                jsonPlaceholder.innerHTML = '<div class="loading-spinner"></div><p>正在处理JSON数据，请稍候...</p><p class="estimated-time">预计完成时间: 正在计算...</p>';
                jsonPlaceholder.style.display = 'flex';
            }
            
            if (jsonResult) {
                jsonResult.style.display = 'none';
            }
            
            // 开始轮询任务状态
            startTaskPolling(url);
        } else {
            // 这是一个直接的JSON URL，显示它
            // 显示JSON地址，去掉末尾的下划线
            jsonFileUrl.textContent = url ? url.replace(/_+$/, '') : url;
            jsonPlaceholder.style.display = 'none';
            jsonResult.style.display = 'flex';
            
            if (document.getElementById('videoProgressBar')) {
                document.getElementById('videoProgressBar').style.display = 'none';
            }
            
            console.log('JSON文件地址已显示:', url);
            
            // 视频生成完成后自动提交到待审核队列
            setTimeout(() => {
              const videoTitle = document.getElementById('bookName')?.value || '生成视频' + new Date().getTime();
              const videoDescription = document.getElementById('bookContent')?.value || '';
              
              // 创建视频对象
              const newVideo = {
                id: 'video-' + Date.now(),
                title: videoTitle,
                description: videoDescription,
                url: url, // 使用生成的JSON URL作为视频URL
                status: 'pending', // 直接设置为待审核状态
                uploadTime: new Date().toISOString(),
                duration: '00:00', // 初始值
                views: 0,
                likes: 0,
                comments: 0,
                author: localStorage.getItem('username') || '匿名用户' // 添加作者字段，从localStorage获取用户名
              };
              
              // 从localStorage获取现有视频列表
              let userVideos = JSON.parse(localStorage.getItem('userVideos') || '[]');
              
              // 添加新视频
              userVideos.push(newVideo);
              
              // 保存更新后的视频列表
              localStorage.setItem('userVideos', JSON.stringify(userVideos));
              
              console.log('视频已自动提交到待审核队列:', newVideo);
              showToast('视频已成功提交审核，请在管理中心查看', 'success');
            }, 1000);
        }
    } catch (error) {
        console.error('显示JSON文件地址失败:', error);
        showToast('显示JSON文件地址时发生错误: ' + error.message, 'error');
    }
}

// 轮询任务状态
function startTaskPolling(taskUrl) {
    const maxAttempts = 120; // 最多轮询120次（延长到10分钟）
    const interval = 5000; // 每5秒轮询一次
    let attempts = 0;
    let pollingTimer = null;
    let pollingTimeout = null;
    
    console.log('开始轮询任务状态，URL:', taskUrl);
    console.log(`设置: 最大尝试次数=${maxAttempts}，轮询间隔=${interval}ms`);
    
    const pollTaskStatus = async () => {
        attempts++;
        console.log(`轮询第${attempts}/${maxAttempts}次，剩余时间约${Math.ceil((maxAttempts - attempts) * interval / 60000)}分钟`);
        
        try {
            // 使用带重试机制的fetch函数替代普通fetch
            const response = await fetchWithRetry(taskUrl, {
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                }
            }, 3, 2000); // 最多重试3次，每次间隔2秒
            
            if (!response.ok) {
                throw new Error(`HTTP错误: ${response.status}`);
            }
            
            const taskStatus = await response.json();
            console.log('任务状态:', taskStatus);

            // 兼容后端返回格式 { success: true, task: {...} }
            const statusObj = (taskStatus && taskStatus.task) ? taskStatus.task : taskStatus;
            
            // 计算进度
            let progress = 0;
            if (statusObj.progress !== undefined) {
                progress = Math.min(100, Math.max(0, statusObj.progress));
            } else {
                // 如果没有进度信息，根据尝试次数估算
                progress = Math.min(100, Math.round((attempts / maxAttempts) * 100));
            }
            
            // 更新进度条
            const progressFill = document.getElementById('videoProgressFill') || document.getElementById('progressFill');
            const progressPercentage = document.getElementById('progressPercentage');
            const estimatedTimeEl = document.querySelector('.estimated-time');
            
            if (progressFill) {
                progressFill.style.width = `${progress}%`;
            }
            
            if (progressPercentage) {
                progressPercentage.textContent = `${progress}%`;
            }
            
            // 计算预计完成时间
            if (estimatedTimeEl && window.videoSystemState && window.videoSystemState.startTime) {
                const elapsed = Date.now() - window.videoSystemState.startTime;
                const estimatedTotalTime = elapsed * (maxAttempts / attempts);
                const remainingTime = Math.max(estimatedTotalTime - elapsed, 0);
                const remainingMinutes = Math.ceil(remainingTime / 60000);
                
                estimatedTimeEl.textContent = `预计完成时间: 约${remainingMinutes}分钟内`;
                console.log(`预计剩余时间: ${remainingMinutes}分钟`);
            }
            
            // 检查是否有JSON文件地址或视频URL
            const finalJsonUrl = statusObj.jsonUrl || statusObj.jsonFileUrl || statusObj.videoUrl || statusObj.cloudVideoUrl;
            if (statusObj.status === 'completed' && finalJsonUrl) {
                // 处理完成，获取最终的URL
                showToast('JSON文件地址已生成！', 'success');
                
                // 显示JSON地址
                const jsonFileUrl = document.getElementById('jsonFileUrl');
                const jsonPlaceholder = document.getElementById('jsonPlaceholder');
                const jsonResult = document.getElementById('jsonResult');
                
                if (jsonFileUrl) {
                    // 去掉末尾的下划线
                    jsonFileUrl.textContent = finalJsonUrl ? finalJsonUrl.replace(/_+$/, '') : finalJsonUrl;
                }
                
                if (jsonPlaceholder) {
                    jsonPlaceholder.style.display = 'none';
                }
                
                if (jsonResult) {
                    jsonResult.style.display = 'flex';
                }
                
                // 更新系统状态，去掉末尾的下划线
                if (window.videoSystemState) {
                    window.videoSystemState.jsonUrl = finalJsonUrl ? finalJsonUrl.replace(/_+$/, '') : finalJsonUrl;
                }
                
                console.log('JSON文件地址加载完成:', finalJsonUrl);
                
                // 清除轮询计时器和超时保护
                clearTimeout(pollingTimer);
                clearTimeout(pollingTimeout);
                return; // 结束轮询
            } else if (statusObj.status === 'completed' && !finalJsonUrl) {
                // 已完成但未返回URL，尝试兜底从 manage-file 获取
                try {
                    const taskId = taskUrl.split('/').pop();
                    const mfResp = await fetch('/api/video/manage-file', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${localStorage.getItem('token')}`
                        },
                        body: JSON.stringify({ taskId: taskId, action: 'get-info' })
                    });
                    if (mfResp.ok) {
                        const mfData = await mfResp.json();
                        const fallbackUrl = mfData?.jsonUrl || mfData?.jsonFileUrl || mfData?.video?.url || mfData?.videoUrl || mfData?.downloadUrl;
                        if (fallbackUrl) {
                            const jsonFileUrl = document.getElementById('jsonFileUrl');
                            const jsonPlaceholder = document.getElementById('jsonPlaceholder');
                            const jsonResult = document.getElementById('jsonResult');
                            
                            if (jsonFileUrl) {
                                // 去掉末尾的下划线
                                jsonFileUrl.textContent = fallbackUrl ? fallbackUrl.replace(/_+$/, '') : fallbackUrl;
                            }
                            
                            if (jsonPlaceholder) {
                                jsonPlaceholder.style.display = 'none';
                            }
                            
                            if (jsonResult) {
                                jsonResult.style.display = 'flex';
                            }
                            
                            if (window.videoSystemState) {
                                // 去掉末尾的下划线
                                window.videoSystemState.jsonUrl = fallbackUrl ? fallbackUrl.replace(/_+$/, '') : fallbackUrl;
                            }
                            
                            showToast('JSON文件地址已生成！', 'success');
                            clearTimeout(pollingTimer);
                            clearTimeout(pollingTimeout);
                            return;
                        }
                    }
                } catch (e) {
                    console.warn('兜底 manage-file 获取URL失败:', e);
                }
            } else if (statusObj.status === 'failed') {
                // 任务失败
                throw new Error(`处理失败: ${statusObj.error || '未知错误'}`);
            } else if (attempts >= maxAttempts) {
                // 达到最大尝试次数，最后兜底尝试一次 manage-file
                try {
                    const taskId = taskUrl.split('/').pop();
                    const mfResp = await fetch('/api/video/manage-file', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${localStorage.getItem('token')}`
                        },
                        body: JSON.stringify({ taskId: taskId, action: 'get-info' })
                    });
                    if (mfResp.ok) {
                        const mfData = await mfResp.json();
                        const fallbackUrl = mfData?.jsonUrl || mfData?.jsonFileUrl || mfData?.video?.url || mfData?.videoUrl || mfData?.downloadUrl;
                        if (fallbackUrl) {
                            const jsonFileUrl = document.getElementById('jsonFileUrl');
                            const jsonPlaceholder = document.getElementById('jsonPlaceholder');
                            const jsonResult = document.getElementById('jsonResult');
                            
                            if (jsonFileUrl) {
                                // 去掉末尾的下划线
                                jsonFileUrl.textContent = fallbackUrl ? fallbackUrl.replace(/_+$/, '') : fallbackUrl;
                            }
                            
                            if (jsonPlaceholder) {
                                jsonPlaceholder.style.display = 'none';
                            }
                            
                            if (jsonResult) {
                                jsonResult.style.display = 'flex';
                            }
                            
                            if (window.videoSystemState) {
                                // 去掉末尾的下划线
                                window.videoSystemState.jsonUrl = fallbackUrl ? fallbackUrl.replace(/_+$/, '') : fallbackUrl;
                            }
                            
                            showToast('JSON文件地址已生成！', 'success');
                            clearTimeout(pollingTimer);
                            clearTimeout(pollingTimeout);
                            return;
                        }
                    }
                } catch (e) {
                    console.warn('最终兜底 manage-file 获取URL失败:', e);
                }
                // 兜底也失败，抛出超时错误
                throw new Error('处理超时，请稍后重试。如果问题持续，请联系客服或尝试使用更短的内容。');
            }
            
            // 继续轮询
            console.log(`等待${interval/1000}秒后进行下一次轮询...`);
            pollingTimer = setTimeout(pollTaskStatus, interval);
            
        } catch (error) {
            console.error('轮询任务状态失败:', error);
            console.error('错误堆栈:', error.stack);
            
            // 显示详细的错误信息
            const errorMessage = error.message || '未知错误';
            showToast(`视频生成过程中发生错误: ${errorMessage}`, 'error');
            
            // 尝试记录更详细的错误信息到控制台
            if (error.response) {
                console.error('HTTP响应错误:', error.response.status, error.response.statusText);
            }
            
            // 重置UI状态
            const videoPlaceholder = document.getElementById('videoPlaceholder');
            if (videoPlaceholder) {
                videoPlaceholder.innerHTML = `<p>视频生成失败</p><p class="error-details">错误信息: ${errorMessage}</p>`;
            }
            
            // 隐藏进度条
            if (document.getElementById('videoProgressBar')) {
                document.getElementById('videoProgressBar').style.display = 'none';
            }
            
            // 清除所有计时器
            clearTimeout(pollingTimer);
            clearTimeout(pollingTimeout);
            
            // 确保重置UI状态
            setTimeout(() => {
                resetUIState();
            }, 2000); // 延迟重置，让用户看到错误信息
        }
    };
    
    // 开始第一次轮询
    pollingTimer = setTimeout(pollTaskStatus, 1000);
    
    // 添加轮询超时保护
    pollingTimeout = setTimeout(() => {
        if (pollingTimer) {
            clearTimeout(pollingTimer);
            pollingTimer = null;
            console.error('轮询过程超时，强制终止轮询');
            resetUIState();
        }
    }, 600000); // 10分钟绝对超时，确保轮询不会无限期进行
}

// 带超时的fetch函数
function fetchWithTimeout(resource, options = {}, timeout = 180000) {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort();
            reject(new Error('Request timeout'));
        }, timeout);

        fetch(resource, { ...options, signal: controller.signal })
            .then(response => {
                clearTimeout(timeoutId);
                resolve(response);
            })
            .catch(error => {
                clearTimeout(timeoutId);
                reject(error);
            });
    });
}

// 带重试机制的fetch函数
async function fetchWithRetry(resource, options = {}, retries = 3, retryDelay = 1000) {
    let lastError;
    
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            // 如果不是第一次尝试，增加延迟
            if (attempt > 0) {
                await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, attempt - 1)));
            }
            
            const response = await fetchWithTimeout(resource, options);
            
            // 如果响应成功，返回结果
            if (response.ok) {
                return response;
            }
            
            // 如果是服务器错误，继续重试
            if (response.status >= 500 || response.status === 429) {
                lastError = new Error(`Server error: ${response.status}`);
                console.warn(`请求失败，将重试 (${attempt + 1}/${retries}):`, lastError);
                continue;
            }
            
            // 其他错误直接抛出
            throw new Error(`Request failed: ${response.status}`);
        } catch (error) {
            // 如果是网络错误或超时，继续重试
            if (error.name === 'TypeError' || error.message === 'Request timeout' || error.name === 'AbortError') {
                lastError = error;
                console.warn(`请求失败，将重试 (${attempt + 1}/${retries}):`, error);
                continue;
            }
            
            // 其他错误直接抛出
            throw error;
        }
    }
    
    // 所有重试都失败后抛出最后一个错误
    throw lastError || new Error('All retry attempts failed');
}

// 调用剪映小助手获取MP4直链
async function callCapCutAssistant(draftUrl) {
    try {
        console.log('调用剪映小助手获取MP4直链，草稿地址:', draftUrl);
        
        // 检查参数有效性
        if (!draftUrl || typeof draftUrl !== 'string') {
            console.error('无效的草稿URL:', draftUrl);
            throw new Error('无效的草稿URL');
        }
        
        // 尝试通过本地守护进程API获取MP4直链
        const response = await fetch('/api/capcut/assistant', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                draftUrl: draftUrl
            })
        });
        
        // 处理响应
        if (!response.ok) {
            console.error('剪映小助手API调用失败，状态码:', response.status);
            
            // 如果服务器返回404，可能是服务不可用，尝试备用方案
            if (response.status === 404) {
                console.log('剪映小助手API不可用，尝试从草稿URL直接提取视频URL');
                const directVideoUrl = tryExtractVideoFromDraftUrl(draftUrl);
                if (directVideoUrl && isValidVideoUrl(directVideoUrl)) {
                    return directVideoUrl;
                }
            }
            
            throw new Error(`API调用失败，状态码: ${response.status}`);
        }
        
        // 解析响应数据
        const result = await response.json();
        
        if (result.success && result.mp4Url) {
            console.log('成功获取MP4直链:', result.mp4Url);
            return result.mp4Url;
        } else {
            console.error('剪映小助手返回失败结果:', result);
            throw new Error(`剪映小助手处理失败: ${result.message || '未知错误'}`);
        }
    } catch (error) {
        console.error('调用剪映小助手时发生异常:', error);
        
        // 尝试备用方案：从草稿URL中提取视频URL
        console.log('尝试备用方案：从草稿URL中提取视频URL');
        const directVideoUrl = tryExtractVideoFromDraftUrl(draftUrl);
        if (directVideoUrl && isValidVideoUrl(directVideoUrl)) {
            console.log('备用方案成功提取视频URL:', directVideoUrl);
            return directVideoUrl;
        }
        
        // 如果所有方案都失败，返回null
        console.error('所有提取视频URL的方案都失败');
        return null;
    }
}

// 辅助函数：从草稿URL中提取视频URL
function tryExtractVideoFromDraftUrl(draftUrl) {
    // 这里应该实现从草稿URL提取视频URL的逻辑
    // 这只是一个占位实现
    console.warn('从草稿URL提取视频URL的功能尚未实现');
    return null;
}

// 辅助函数：验证视频URL是否有效
function isValidVideoUrl(url) {
    return url && typeof url === 'string' && (url.endsWith('.mp4') || url.includes('.mp4?'));
}

// 视频系统初始化函数 - 与create-video.html中调用的函数名匹配
function initializeVideoSystem() {
    console.log('视频生成系统已使用服务端SDK初始化');
    showToast('视频生成服务已就绪，可以开始使用', 'success');
    
    // 初始化视频系统状态
    if (typeof window.videoSystemState === 'undefined') {
        window.videoSystemState = {
            sdkLoaded: false,
            sdkInitialized: false,
            webChatClient: null,
            loadingAttempts: 0,
            maxAttempts: 8,
            isGenerating: false,
            videoUrl: null,
            space_id: '7545798611513196554',
            workflow_id: '7545800016074817574',
            bot_id: '7545799369434677294',
            isDemoMode: false,
            currentTaskId: null,
            foundValidData: false,
            lastWorkflowResponse: null
        };
    }
    
    // 为生成按钮添加点击事件监听器
    const generateBtn = document.getElementById('generateBtn');
    if (generateBtn) {
        // 确保只添加一次事件监听器
        const newGenerateBtn = generateBtn.cloneNode(true);
        if (generateBtn.parentNode) {
            generateBtn.parentNode.replaceChild(newGenerateBtn, generateBtn);
        }
        newGenerateBtn.addEventListener('click', generateVideo);
        console.log('已为生成视频按钮添加点击事件监听器');
    }
}

// 在页面加载完成后自动初始化视频系统
window.addEventListener('DOMContentLoaded', function() {
    console.log('页面加载完成，开始初始化视频系统');
    initializeVideoSystem();
});


// 显示JSON数据信息给用户 - 只显示工作流返回的原始地址
async function showJsonInfo(jsonData, originalWorkflowUrl) {
    // 获取JSON相关元素
    const jsonPlaceholder = document.getElementById('jsonPlaceholder');
    const jsonResult = document.getElementById('jsonResult');
    const jsonFileUrl = document.getElementById('jsonFileUrl');
    
    // 先隐藏JSON结果区域，等待自动化流程完成
    if (jsonResult) {
        jsonResult.style.display = 'none';
    }
    
    // 如果有JSON地址，优先调用自动化流程API生成视频
    if (originalWorkflowUrl) {
        const cleanUrl = originalWorkflowUrl.replace(/_+$/, '');
        console.log('检测到JSON地址，开始自动生成视频:', cleanUrl);
        
        // 显示加载状态
        if (jsonPlaceholder) {
            jsonPlaceholder.style.display = 'flex';
            jsonPlaceholder.innerHTML = '<div class="loading-spinner"></div><p>正在自动生成视频，请稍候...</p><p class="text-sm text-gray-500">步骤：调用剪映小助手 → 生成素材文件 → 复制到剪映草稿 → 等待视频生成</p>';
        }
        
        // 获取图书信息
        const bookName = document.getElementById('bookName')?.value.trim() || '未命名图书';
        const bookContent = document.getElementById('bookContent')?.value.trim() || '';
        
        try {
            // 调用自动化流程API
            const userToken = localStorage.getItem('token');
            if (!userToken) {
                showToast('用户未登录，无法自动生成视频', 'error');
                return;
            }
            
            const response = await fetch('/api/video/auto-generate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${userToken}`
                },
                body: JSON.stringify({
                    jsonUrl: cleanUrl,
                    bookInfo: {
                        title: bookName,
                        content: bookContent
                    }
                })
            });
            
            if (!response.ok) {
                let errorMessage = `HTTP错误: ${response.status} ${response.statusText}`;
                try {
                    const errorData = await response.json();
                    errorMessage = errorData.message || errorMessage;
                } catch (jsonError) {
                    // 如果响应不是JSON，尝试读取文本
                    const text = await response.text();
                    console.error('服务器返回非JSON响应:', text.substring(0, 200));
                    if (response.status === 404) {
                        errorMessage = 'API端点未找到，请确保服务器已重启并包含最新代码';
                    } else {
                        errorMessage = `服务器错误: ${response.status}`;
                    }
                }
                throw new Error(errorMessage);
            }
            
            const result = await response.json();
            console.log('自动化流程完成:', result);
            console.log('API返回的完整对象:', JSON.stringify(result, null, 2));
            
            if (result.success) {
                console.log('API返回结果:', result);
                console.log('检查视频URL字段:');
                console.log('  - result.videoUrl:', result.videoUrl);
                console.log('  - result.video_file:', result.video_file);
                console.log('  - result.videoFile:', result.videoFile);
                console.log('  - result.mp4Url:', result.mp4Url);
                console.log('  - result.play_url:', result.play_url);
                console.log('  - result.playUrl:', result.playUrl);
                console.log('  - result.url:', result.url);
                console.log('  - result.jianyingIds:', result.jianyingIds);
                console.log('  - result.draftPath:', result.draftPath);
                
                // 检查是否有视频URL（支持多种可能的字段名）
                const videoUrl = result.videoUrl || result.video_file || result.videoFile || result.mp4Url || result.play_url || result.playUrl || result.url;
                
                if (videoUrl) {
                    console.log('检测到视频URL:', videoUrl);
                    // 显示视频
                    showVideo(videoUrl);
                    showToast('视频生成成功！', 'success');
                } else {
                    // 没有找到视频文件，显示草稿信息
                    console.log('未找到视频URL，显示草稿信息');
                    const draftPath = result.draftPath;
                    const jianyingIds = result.jianyingIds;
                    const draftId = result.draftId;
                    
                    let statusMessage = '草稿已创建';
                    let detailMessage = '';
                    let pathInfo = '';
                    
                    if (draftPath) {
                        statusMessage = '素材已复制到剪映草稿目录';
                        detailMessage = '请在剪映专业版的草稿箱中查看生成的视频';
                        pathInfo = `<p style="font-size: 12px; color: #999; word-break: break-all; margin-top: 10px;">草稿路径: ${draftPath}</p>`;
                    } else if (jianyingIds || draftId) {
                        statusMessage = '草稿已创建并同步到剪映云空间';
                        detailMessage = '视频正在生成中，请稍后在剪映专业版的草稿箱中查看';
                        if (jianyingIds) {
                            pathInfo = `<p style="font-size: 12px; color: #999; word-break: break-all; margin-top: 10px;">草稿ID: ${jianyingIds}</p>`;
                        } else if (draftId) {
                            pathInfo = `<p style="font-size: 12px; color: #999; word-break: break-all; margin-top: 10px;">草稿ID: ${draftId}</p>`;
                        }
                        pathInfo += `<p style="font-size: 11px; color: #999; margin-top: 5px;">注意: 草稿仅存在于剪映云空间，本地路径不存在</p>`;
                    } else {
                        statusMessage = '草稿已创建';
                        detailMessage = '请在剪映专业版的草稿箱中查看生成的视频';
                    }
                    
                    if (result.note) {
                        detailMessage = result.note;
                    }
                    
                    showToast(statusMessage + '，请在剪映中查看', 'info');
                    
                    // 显示提示信息
                    if (jsonPlaceholder) {
                        jsonPlaceholder.style.display = 'flex';
                        jsonPlaceholder.innerHTML = `
                            <div class="text-center" style="padding: 20px;">
                                <i class="fas fa-check-circle" style="color: #4CAF50; font-size: 48px; margin-bottom: 20px;"></i>
                                <p style="font-size: 18px; font-weight: bold; margin-bottom: 10px; color: #333;">${statusMessage}</p>
                                <p style="font-size: 14px; color: #666; margin-bottom: 20px;">${detailMessage}</p>
                                ${pathInfo}
                            </div>
                        `;
                    }
                }
            } else {
                throw new Error(result.message || '生成视频失败');
            }
        } catch (error) {
            console.error('自动生成视频失败:', error);
            console.log('自动生成视频失败，显示JSON地址作为备用');
            showToast('自动生成视频失败，已显示JSON地址: ' + error.message, 'warning');
            
            // 显示JSON地址作为备用方案
            showJsonAddressAsFallback(originalWorkflowUrl);
        }
    } else {
        // 如果没有JSON地址，显示提示
        if (jsonPlaceholder) {
            jsonPlaceholder.style.display = 'flex';
            jsonPlaceholder.innerHTML = `
                <div class="text-center" style="padding: 20px;">
                    <i class="fas fa-info-circle" style="color: #2196F3; font-size: 48px; margin-bottom: 20px;"></i>
                    <p style="font-size: 18px; font-weight: bold; margin-bottom: 10px; color: #333;">未找到JSON地址</p>
                    <p style="font-size: 14px; color: #666;">请重新生成视频</p>
                </div>
            `;
        }
    }
}

// 显示JSON地址作为备用方案
function showJsonAddressAsFallback(originalWorkflowUrl) {
    const jsonPlaceholder = document.getElementById('jsonPlaceholder');
    const jsonResult = document.getElementById('jsonResult');
    const jsonFileUrl = document.getElementById('jsonFileUrl');
    
    // 隐藏占位符，显示结果区域
    if (jsonPlaceholder) {
        jsonPlaceholder.style.display = 'none';
    }
    if (jsonResult) {
        jsonResult.style.display = 'block';
        
        // 清除任何可能存在的数据预览容器
        const jsonDisplayContainer = document.getElementById('jsonDisplayContainer');
        if (jsonDisplayContainer) {
            jsonDisplayContainer.remove();
        }
        
        // 清除可能存在的原始地址容器
        const existingOriginalUrlContainer = document.getElementById('originalWorkflowUrlContainer');
        if (existingOriginalUrlContainer) {
            existingOriginalUrlContainer.remove();
        }
        
        // 使用主JSON地址区域显示工作流原始地址
        if (jsonFileUrl) {
            // 设置为工作流返回的原始地址，去掉末尾的下划线
            const cleanUrl = originalWorkflowUrl ? originalWorkflowUrl.replace(/_+$/, '') : null;
            jsonFileUrl.textContent = cleanUrl || '未找到工作流返回地址';
            // 优化显示样式
            jsonFileUrl.style.cssText = 'word-break: break-all; padding: 10px; background-color: #e8f5e9; border-radius: 4px; display: block; border-left: 4px solid #4CAF50;';
        }
    }
}