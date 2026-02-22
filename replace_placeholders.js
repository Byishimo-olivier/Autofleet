const fs = require('fs');
const path = require('path');

function walkDir(dir, callback) {
    fs.readdirSync(dir).forEach(f => {
        let dirPath = path.join(dir, f);
        let isDirectory = fs.statSync(dirPath).isDirectory();
        isDirectory ? walkDir(dirPath, callback) : callback(path.join(dir, f));
    });
}

walkDir('c:/Users/HP/Downloads/byron/frontend/src', function (filePath) {
    if (filePath.endsWith('.tsx') || filePath.endsWith('.ts')) {
        let content = fs.readFileSync(filePath, 'utf8');
        if (content.includes('placeholder.png')) {
            let newContent = content.replace(/['"]\/placeholder\.png['"]/g, "'https://placehold.co/600x400?text=No+Image'");
            if (newContent !== content) {
                fs.writeFileSync(filePath, newContent);
                console.log('Updated: ' + filePath);
            }
        }
    }
});
