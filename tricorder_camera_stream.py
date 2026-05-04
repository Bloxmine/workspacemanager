#!/usr/bin/env python3
"""
Medical Tricorder Webcam Streamer
Streams webcam feed from Raspberry Pi to main computer via HTTP/MJPEG
"""

import cv2
import argparse
import time
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from io import BytesIO
import sys

class WebcamStreamer:
    def __init__(self, camera_id=0, width=640, height=480, fps=30):
        self.camera_id = camera_id
        self.width = width
        self.height = height
        self.fps = fps
        self.cap = None
        self.current_frame = None
        self.frame_lock = threading.Lock()
        self.running = False
        
    def init_camera(self):
        """Initialize camera connection"""
        self.cap = cv2.VideoCapture(self.camera_id)
        if not self.cap.isOpened():
            print(f"Error: Could not open camera {self.camera_id}")
            return False
            
        # Set camera properties
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        self.cap.set(cv2.CAP_PROP_FPS, self.fps)
        self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        
        print(f"Camera initialized: {self.width}x{self.height} @ {self.fps}fps")
        return True
        
    def capture_frames(self):
        """Continuously capture frames from camera"""
        if not self.init_camera():
            return
            
        frame_count = 0
        start_time = time.time()
        
        while self.running:
            ret, frame = self.cap.read()
            if not ret:
                print("Error: Failed to read frame")
                continue
                
            # Resize frame
            frame = cv2.resize(frame, (self.width, self.height))
            
            # Add timestamp
            timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
            cv2.putText(frame, timestamp, (10, 30), 
                       cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
            
            # Add FPS counter
            frame_count += 1
            elapsed = time.time() - start_time
            if elapsed > 1:
                fps = frame_count / elapsed
                cv2.putText(frame, f"FPS: {fps:.1f}", (self.width - 150, 30),
                           cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
                frame_count = 0
                start_time = time.time()
            
            with self.frame_lock:
                self.current_frame = frame.copy()
            
            # Control frame rate
            time.sleep(1 / self.fps)
        
        self.cap.release()
        
    def get_frame_jpeg(self):
        """Get current frame as JPEG bytes"""
        with self.frame_lock:
            if self.current_frame is None:
                return None
            ret, buffer = cv2.imencode('.jpg', self.current_frame, 
                                      [cv2.IMWRITE_JPEG_QUALITY, 80])
            if ret:
                return buffer.tobytes()
        return None
        
    def start(self):
        """Start streaming"""
        self.running = True
        capture_thread = threading.Thread(target=self.capture_frames, daemon=True)
        capture_thread.start()
        
    def stop(self):
        """Stop streaming"""
        self.running = False


class StreamHandler(BaseHTTPRequestHandler):
    """HTTP request handler for MJPEG stream"""
    
    streamer = None
    
    def do_GET(self):
        if self.path == '/':
            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            html = """
            <html>
            <head>
                <title>Medical Tricorder Camera Feed</title>
                <style>
                    body { 
                        background: #000; 
                        color: #fff; 
                        font-family: Arial; 
                        text-align: center;
                        padding: 20px;
                    }
                    img { 
                        max-width: 100%; 
                        height: auto; 
                        border: 2px solid #f9911e;
                        border-radius: 10px;
                    }
                    .info {
                        margin-top: 20px;
                        font-size: 14px;
                    }
                </style>
            </head>
            <body>
                <h1>Medical Tricorder</h1>
                <h2>Camera Feed</h2>
                <img src="/stream" alt="Camera Stream">
                <div class="info">
                    <p>MJPEG Stream: 640x480 @ 30fps</p>
                    <p>Timestamp visible on feed</p>
                </div>
            </body>
            </html>
            """.encode('utf-8')
            self.wfile.write(html)
            
        elif self.path == '/stream':
            self.send_response(200)
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
            self.end_headers()
            
            try:
                while self.streamer.running:
                    frame = self.streamer.get_frame_jpeg()
                    if frame:
                        self.wfile.write(b'--frame\r\n')
                        self.wfile.write(b'Content-Type: image/jpeg\r\n')
                        self.wfile.write(f'Content-Length: {len(frame)}\r\n\r\n'.encode())
                        self.wfile.write(frame)
                        self.wfile.write(b'\r\n')
                    time.sleep(0.033)  # ~30fps
            except Exception as e:
                print(f"Stream error: {e}")
                
        else:
            self.send_response(404)
            self.end_headers()
            
    def log_message(self, format, *args):
        """Suppress default logging"""
        pass


def main():
    parser = argparse.ArgumentParser(
        description='Medical Tricorder Webcam Streamer'
    )
    parser.add_argument('--camera', type=int, default=0,
                       help='Camera device ID (default: 0)')
    parser.add_argument('--width', type=int, default=640,
                       help='Frame width (default: 640)')
    parser.add_argument('--height', type=int, default=480,
                       help='Frame height (default: 480)')
    parser.add_argument('--fps', type=int, default=30,
                       help='Frames per second (default: 30)')
    parser.add_argument('--host', type=str, default='0.0.0.0',
                       help='Server host (default: 0.0.0.0)')
    parser.add_argument('--port', type=int, default=8080,
                       help='Server port (default: 8080)')
    
    args = parser.parse_args()
    
    # Create streamer
    streamer = WebcamStreamer(
        camera_id=args.camera,
        width=args.width,
        height=args.height,
        fps=args.fps
    )
    
    # Start streaming
    streamer.start()
    
    # Setup request handler
    StreamHandler.streamer = streamer
    
    # Create and start server
    server = HTTPServer((args.host, args.port), StreamHandler)
    print(f"\n{'='*50}")
    print(f"Medical Tricorder Camera Stream")
    print(f"{'='*50}")
    print(f"Server running on http://{args.host}:{args.port}")
    print(f"Stream available at: http://{args.host}:{args.port}/stream")
    print(f"Web interface: http://{args.host}:{args.port}/")
    print(f"Resolution: {args.width}x{args.height}")
    print(f"FPS: {args.fps}")
    print(f"Camera: {args.camera}")
    print(f"\nPress Ctrl+C to stop")
    print(f"{'='*50}\n")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n\nShutting down...")
        streamer.stop()
        server.shutdown()
        print("Camera stream stopped")
        sys.exit(0)


if __name__ == '__main__':
    main()
