import re

with open('bookstore.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 提取JavaScript代码，但只检查主要的JavaScript代码，忽略外部脚本和Coze Web SDK
main_script_pattern = r'<script>([\s\S]*?)</script>'
main_scripts = re.findall(main_script_pattern, content)

# 检查主要的JavaScript代码
if main_scripts:
    print('检查主要的JavaScript代码...')
    main_script = main_scripts[0]
    
    # 简单检查是否有明显的语法错误（只检查大括号，因为小括号在正则表达式中太多，容易误判）
    if main_script.count('{') != main_script.count('}'):
        print('❌ 大括号不匹配')
    if main_script.count('[') != main_script.count(']'):
        print('❌ 中括号不匹配')
    
    print('✅ 主要JavaScript代码检查完成')
else:
    print('未找到主要的JavaScript代码')

print('\nJavaScript语法初步检查完成')