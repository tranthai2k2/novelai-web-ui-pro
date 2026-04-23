import http.server
import socketserver
import json
import urllib.request
import os
import time
import zipfile
import io

PORT = 3000
HARDCODED_KEY = "pst-oSRBwwBcAQqZbmZzHdVxsBTJlRQI2T7x4IehlrtWB28B2hPpIIEtFo9VeIevwYeK"

class NovelAIProxyHandler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/api/read-prompts':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            payload = json.loads(post_data.decode('utf-8'))
            folder_path = payload.get('folderPath')
            
            if not folder_path:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"Folder path is required")
                return

            possible_paths = [
                os.path.join(folder_path, 'addfaceless.txt'),
                os.path.join(folder_path, 'out_tags', 'addfaceless.txt'),
                folder_path
            ]

            file_path = None
            for p in possible_paths:
                if os.path.exists(p) and os.path.isfile(p):
                    file_path = p
                    break
            
            if not file_path:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b"addfaceless.txt not found")
                return

            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    lines = [l.strip() for l in f.readlines() if l.strip()]
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'prompts': lines}).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(str(e).encode('utf-8'))

        elif self.path == '/api/generate':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            payload = json.loads(post_data.decode('utf-8'))
            
            folder_name = payload.pop('folderName', 'default')
            
            # Forward to NovelAI
            req = urllib.request.Request(
                "https://image.novelai.net/ai/generate-image",
                data=json.dumps(payload).encode('utf-8'),
                headers={
                    'Authorization': f"Bearer {HARDCODED_KEY}",
                    'Content-Type': 'application/json',
                    'Accept': 'application/x-zip-compressed'
                },
                method='POST'
            )
            
            try:
                with urllib.request.urlopen(req) as response:
                    data = response.read()
                    
                    # Save images to folder
                    output_dir = os.path.join(os.getcwd(), 'output')
                    char_dir = os.path.join(output_dir, folder_name)
                    
                    if not os.path.exists(output_dir): os.makedirs(output_dir)
                    if not os.path.exists(char_dir): os.makedirs(char_dir)
                    
                    with zipfile.ZipFile(io.BytesIO(data)) as z:
                        for filename in z.namelist():
                            if filename.endswith('.png'):
                                timestamp = int(time.time() * 1000)
                                save_path = os.path.join(char_dir, f"{timestamp}_{filename}")
                                with open(save_path, 'wb') as f:
                                    f.write(z.read(filename))
                                print(f"Saved image to: {save_path}")
                    
                    # Send back to client
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/x-zip-compressed')
                    self.end_headers()
                    self.wfile.write(data)
            except Exception as e:
                print(f"Error: {e}")
                self.send_response(500)
                self.end_headers()
                self.wfile.write(str(e).encode('utf-8'))
        else:
            super().do_POST()

    def do_GET(self):
        # Serve static files from dist if exists, otherwise serve from root
        if os.path.exists('dist'):
            if self.path == '/':
                self.path = '/dist/index.html'
            else:
                self.path = '/dist' + self.path
        return super().do_GET()

if __name__ == "__main__":
    with socketserver.TCPServer(("0.0.0.0", PORT), NovelAIProxyHandler) as httpd:
        print(f"Python NovelAI Proxy running on port {PORT}")
        httpd.serve_forever()
