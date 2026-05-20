from html.parser import HTMLParser
import sys

class HTMLSyntaxChecker(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack = []
        self.errors = []
        self.line = 1
        self.col = 1
    
    def handle_starttag(self, tag, attrs):
        if tag not in ['br', 'hr', 'img', 'input', 'meta', 'link']:
            self.stack.append((tag, self.line, self.col))
        self.update_position()
    
    def handle_endtag(self, tag):
        if tag not in ['br', 'hr', 'img', 'input', 'meta', 'link']:
            if not self.stack:
                self.errors.append(f"Line {self.line}: Closing tag </{tag}> without matching opening tag")
            else:
                last_tag, last_line, last_col = self.stack.pop()
                if last_tag != tag:
                    self.errors.append(f"Line {self.line}: Closing tag </{tag}> doesn't match opening tag <{last_tag}> at line {last_line}")
        self.update_position()
    
    def handle_data(self, data):
        self.update_position(data)
    
    def update_position(self, data=""):
        for c in data:
            if c == '\n':
                self.line += 1
                self.col = 1
            else:
                self.col += 1
    
    def check_completeness(self):
        while self.stack:
            tag, line, col = self.stack.pop()
            self.errors.append(f"Line {line}: Opening tag <{tag}> without matching closing tag")

def check_html_syntax(file_path):
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        parser = HTMLSyntaxChecker()
        parser.feed(content)
        parser.check_completeness()
        
        if parser.errors:
            print(f"Found {len(parser.errors)} errors in {file_path}:")
            for error in parser.errors:
                print(f"  {error}")
            return False
        else:
            print(f"No HTML syntax errors found in {file_path}!")
            return True
    except Exception as e:
        print(f"Error checking {file_path}: {e}")
        return False

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python check_html.py <file_path>")
        sys.exit(1)
    
    file_path = sys.argv[1]
    success = check_html_syntax(file_path)
    sys.exit(0 if success else 1)