#!/bin/bash
# =============================================================================
# Setup Claude Code Skills - Official Anthropic Office Skills
# =============================================================================
# Part of agent-kit - portable Claude Code configuration
#
# Usage:
#   ./scripts/setup-skills.sh           # Install all recommended skills
#   ./scripts/setup-skills.sh --list    # Show current skills
#   ./scripts/setup-skills.sh --remove  # Remove skills
# =============================================================================

set -euo pipefail

SKILLS_DIR="$HOME/.claude/skills"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error() { echo -e "${RED}❌ $1${NC}"; }

# =============================================================================
# SKILL DEFINITIONS
# =============================================================================

setup_pdf_skill() {
    local skill_dir="$SKILLS_DIR/pdf"
    mkdir -p "$skill_dir"

    cat > "$skill_dir/SKILL.md" << 'EOF'
---
name: pdf
description: Create and manipulate PDF documents
tools: ["Write", "Read", "Bash"]
---

# PDF Document Skill

You can create, read, and manipulate PDF documents.

## Capabilities

- **Create PDFs**: Generate professional PDF documents from text/markdown
- **Fill PDF Forms**: Populate fillable PDF form fields
- **Merge PDFs**: Combine multiple PDFs into one
- **Extract Text**: Extract text content from PDF files
- **Convert to Images**: Convert PDF pages to PNG/JPEG images

## Usage Examples

### Create a PDF
```bash
# Using pandoc (if available)
pandoc input.md -o output.pdf

# Using Python with reportlab
python3 -c "
from reportlab.pdfgen import canvas
c = canvas.Canvas('output.pdf')
c.drawString(100, 750, 'Hello, PDF!')
c.save()
"
```

### Extract Text from PDF
```bash
# Using pdftotext (poppler-utils)
pdftotext input.pdf output.txt

# Using Python with PyPDF2
python3 -c "
import PyPDF2
with open('input.pdf', 'rb') as f:
    reader = PyPDF2.PdfReader(f)
    for page in reader.pages:
        print(page.extract_text())
"
```

### Merge PDFs
```bash
# Using Python with PyPDF2
python3 -c "
from PyPDF2 import PdfMerger
merger = PdfMerger()
merger.append('file1.pdf')
merger.append('file2.pdf')
merger.write('merged.pdf')
merger.close()
"
```

## Dependencies

Install required tools:
```bash
# macOS
brew install poppler pandoc

# Python packages
pip install PyPDF2 reportlab
```
EOF

    log_success "Created PDF skill"
}

setup_xlsx_skill() {
    local skill_dir="$SKILLS_DIR/xlsx"
    mkdir -p "$skill_dir"

    cat > "$skill_dir/SKILL.md" << 'EOF'
---
name: xlsx
description: Create and manipulate Excel spreadsheets
tools: ["Write", "Read", "Bash"]
---

# Excel Spreadsheet Skill

You can create, read, and manipulate Excel (.xlsx) files.

## Capabilities

- **Create Spreadsheets**: Generate Excel files with data, formulas, and formatting
- **Read Data**: Parse and extract data from existing spreadsheets
- **Modify Spreadsheets**: Update cells, add sheets, apply formatting
- **Formulas**: Add and calculate Excel formulas
- **Charts**: Create charts and visualizations

## Usage Examples

### Create a Spreadsheet
```python
import openpyxl
from openpyxl.styles import Font, Alignment

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Data"

# Headers
ws['A1'] = 'Name'
ws['B1'] = 'Value'
ws['A1'].font = Font(bold=True)
ws['B1'].font = Font(bold=True)

# Data
ws['A2'] = 'Item 1'
ws['B2'] = 100
ws['A3'] = 'Item 2'
ws['B3'] = 200

# Formula
ws['B4'] = '=SUM(B2:B3)'

wb.save('output.xlsx')
```

### Read a Spreadsheet
```python
import openpyxl

wb = openpyxl.load_workbook('input.xlsx')
ws = wb.active

for row in ws.iter_rows(min_row=1, max_row=10, values_only=True):
    print(row)
```

### Convert CSV to Excel
```python
import pandas as pd

df = pd.read_csv('input.csv')
df.to_excel('output.xlsx', index=False)
```

## Dependencies

```bash
pip install openpyxl pandas xlsxwriter
```
EOF

    log_success "Created XLSX skill"
}

setup_docx_skill() {
    local skill_dir="$SKILLS_DIR/docx"
    mkdir -p "$skill_dir"

    cat > "$skill_dir/SKILL.md" << 'EOF'
---
name: docx
description: Create and manipulate Word documents
tools: ["Write", "Read", "Bash"]
---

# Word Document Skill

You can create, read, and manipulate Word (.docx) files.

## Capabilities

- **Create Documents**: Generate professional Word documents
- **Read Documents**: Extract text and structure from existing documents
- **Modify Documents**: Update content, formatting, styles
- **Tables**: Create and format tables
- **Images**: Insert and position images

## Usage Examples

### Create a Document
```python
from docx import Document
from docx.shared import Inches, Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()

# Title
title = doc.add_heading('Document Title', 0)
title.alignment = WD_ALIGN_PARAGRAPH.CENTER

# Paragraph
doc.add_paragraph('This is a paragraph with some text.')

# Bullet list
doc.add_paragraph('First item', style='List Bullet')
doc.add_paragraph('Second item', style='List Bullet')

# Table
table = doc.add_table(rows=2, cols=2)
table.style = 'Table Grid'
table.cell(0, 0).text = 'Header 1'
table.cell(0, 1).text = 'Header 2'
table.cell(1, 0).text = 'Data 1'
table.cell(1, 1).text = 'Data 2'

doc.save('output.docx')
```

### Read a Document
```python
from docx import Document

doc = Document('input.docx')
for para in doc.paragraphs:
    print(para.text)
```

### Convert to PDF
```bash
# Using LibreOffice
libreoffice --headless --convert-to pdf document.docx

# Using pandoc
pandoc document.docx -o document.pdf
```

## Dependencies

```bash
pip install python-docx
brew install libreoffice  # For PDF conversion
```
EOF

    log_success "Created DOCX skill"
}

setup_pptx_skill() {
    local skill_dir="$SKILLS_DIR/pptx"
    mkdir -p "$skill_dir"

    cat > "$skill_dir/SKILL.md" << 'EOF'
---
name: pptx
description: Create and manipulate PowerPoint presentations
tools: ["Write", "Read", "Bash"]
---

# PowerPoint Presentation Skill

You can create, read, and manipulate PowerPoint (.pptx) files.

## Capabilities

- **Create Presentations**: Generate professional slide decks
- **Read Presentations**: Extract content from existing presentations
- **Modify Slides**: Update text, images, formatting
- **Charts**: Add charts and visualizations
- **Templates**: Apply slide templates and themes

## Usage Examples

### Create a Presentation
```python
from pptx import Presentation
from pptx.util import Inches, Pt

prs = Presentation()

# Title slide
title_slide = prs.slides.add_slide(prs.slide_layouts[0])
title = title_slide.shapes.title
subtitle = title_slide.placeholders[1]
title.text = "Presentation Title"
subtitle.text = "Subtitle or Author"

# Content slide
content_slide = prs.slides.add_slide(prs.slide_layouts[1])
title = content_slide.shapes.title
body = content_slide.placeholders[1]
title.text = "Slide Title"
tf = body.text_frame
tf.text = "First bullet point"
p = tf.add_paragraph()
p.text = "Second bullet point"
p.level = 1

prs.save('presentation.pptx')
```

### Read a Presentation
```python
from pptx import Presentation

prs = Presentation('input.pptx')
for slide in prs.slides:
    for shape in slide.shapes:
        if hasattr(shape, "text"):
            print(shape.text)
```

## Dependencies

```bash
pip install python-pptx
```
EOF

    log_success "Created PPTX skill"
}

# =============================================================================
# MAIN FUNCTIONS
# =============================================================================

list_skills() {
    echo ""
    echo "============================================================"
    echo "🎯 INSTALLED SKILLS"
    echo "============================================================"
    echo ""

    if [[ -d "$SKILLS_DIR" ]]; then
        for skill in "$SKILLS_DIR"/*/; do
            if [[ -f "${skill}SKILL.md" ]]; then
                local name=$(basename "$skill")
                local desc=$(grep "^description:" "${skill}SKILL.md" | cut -d: -f2- | xargs)
                echo "  ✅ $name - $desc"
            fi
        done
    else
        echo "  No skills installed"
    fi
    echo ""
}

install_all_skills() {
    echo ""
    echo "============================================================"
    echo "🎯 INSTALLING CLAUDE CODE SKILLS"
    echo "============================================================"
    echo ""

    mkdir -p "$SKILLS_DIR"

    setup_pdf_skill
    setup_xlsx_skill
    setup_docx_skill
    setup_pptx_skill

    echo ""
    log_success "All skills installed!"
    list_skills

    echo ""
    echo "📋 Skills are loaded automatically when relevant."
    echo "   Use 'pdf', 'xlsx', 'docx', or 'pptx' in your prompts."
    echo ""
}

remove_skills() {
    echo ""
    echo "============================================================"
    echo "🗑️  REMOVING SKILLS"
    echo "============================================================"
    echo ""

    if [[ -d "$SKILLS_DIR" ]] && [[ -n "$SKILLS_DIR" ]] && [[ "$SKILLS_DIR" != "/" ]]; then
        rm -rf "$SKILLS_DIR"
        log_success "Skills directory removed"
    else
        log_warning "No skills directory found"
    fi
}

# =============================================================================
# MAIN
# =============================================================================

main() {
    case "${1:-}" in
        --list)
            list_skills
            ;;
        --remove)
            remove_skills
            ;;
        *)
            install_all_skills
            ;;
    esac
}

main "$@"
