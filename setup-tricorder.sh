#!/bin/bash

# Medical Tricorder - Raspberry Pi Automated Setup Script
# Run this script on your Raspberry Pi to set up the tricorder device

set -e

echo "============================================"
echo "Medical Tricorder Setup Script"
echo "============================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper functions
print_status() {
    echo -e "${GREEN}[✓]${NC} $1"
}

print_error() {
    echo -e "${RED}[✗]${NC} $1"
}

print_info() {
    echo -e "${YELLOW}[i]${NC} $1"
}

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    print_error "This script must be run as root"
    echo "Try: sudo bash $0"
    exit 1
fi

# Get non-root user
if [ -z "$SUDO_USER" ]; then
    ACTUAL_USER="pi"
else
    ACTUAL_USER="$SUDO_USER"
fi

WORKSPACE_DIR="/home/$ACTUAL_USER/workspace-manager"

print_info "Setting up Tricorder on Raspberry Pi"
print_info "User: $ACTUAL_USER"
print_info "Workspace: $WORKSPACE_DIR"
echo ""

# Update system
print_info "Updating system packages..."
apt-get update
apt-get upgrade -y
print_status "System packages updated"

# Install required packages
print_info "Installing required packages..."
apt-get install -y \
    git \
    python3-pip \
    python3-dev \
    libatlas-base-dev \
    libjasper-dev \
    libtiff5 \
    libjasper1 \
    libharfbuzz0b \
    libwebp6 \
    xserver-xorg \
    xserver-xorg-video-fbdev \
    x11-xserver-utils \
    xinit \
    xterm \
    chromium-browser \
    ffmpeg \
    v4l-utils \
    build-essential \
    cmake \
    gfortran \
    wget \
    libharfbuzz0b \
    libwebp6 \
    libtiff5 \
    libharfbuzz0b \
    libwebp6 \
    libjasper1

print_status "Required packages installed"

# Install Node.js
print_info "Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs
print_status "Node.js installed: $(node --version)"

# Create workspace directory if it doesn't exist
if [ ! -d "$WORKSPACE_DIR" ]; then
    print_info "Creating workspace directory..."
    mkdir -p "$WORKSPACE_DIR"
    chown "$ACTUAL_USER:$ACTUAL_USER" "$WORKSPACE_DIR"
    print_status "Workspace directory created"
else
    print_info "Workspace directory already exists"
fi

# Copy files if they don't exist
print_info "Setting up tricorder files..."
for file in tricorder-display.html tricorder_camera_stream.py tricorder_requirements.txt; do
    if [ -f "$file" ]; then
        cp "$file" "$WORKSPACE_DIR/"
        chown "$ACTUAL_USER:$ACTUAL_USER" "$WORKSPACE_DIR/$file"
        print_status "Copied $file"
    else
        print_error "File not found: $file (skipping)"
    fi
done

# Install Python dependencies
print_info "Installing Python dependencies..."
if [ -f "$WORKSPACE_DIR/tricorder_requirements.txt" ]; then
    pip3 install -r "$WORKSPACE_DIR/tricorder_requirements.txt"
    print_status "Python dependencies installed"
else
    print_error "tricorder_requirements.txt not found"
    print_info "Installing opencv-python and numpy manually..."
    pip3 install opencv-python numpy
fi

# Create systemd services
print_info "Setting up systemd services..."

# Camera service
cat > /etc/systemd/system/tricorder-camera.service << 'EOF'
[Unit]
Description=Medical Tricorder Camera Stream
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/workspace-manager
ExecStart=/usr/bin/python3 tricorder_camera_stream.py --host 0.0.0.0 --port 8080
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

print_status "Camera service created"

# Display service
cat > /etc/systemd/system/tricorder-display.service << 'EOF'
[Unit]
Description=Medical Tricorder Display (Kiosk Mode)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
ExecStart=/bin/bash -c 'sleep 3 && DISPLAY=:0 /usr/bin/chromium-browser --kiosk --no-sandbox --disable-gpu --disable-dev-shm-usage --disable-extensions "http://localhost:3000/tricorder-display.html"'
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

print_status "Display service created"

# Reload systemd daemon
systemctl daemon-reload
print_status "Systemd daemon reloaded"

# Enable services
print_info "Enabling services..."
systemctl enable tricorder-camera
systemctl enable tricorder-display
print_status "Services enabled"

# Camera permissions
print_info "Setting up camera permissions..."
usermod -a -G video pi
usermod -a -G audio pi
print_status "Camera permissions updated"

# Create startup script
print_info "Creating startup helpers..."
cat > "/home/$ACTUAL_USER/start-tricorder.sh" << 'EOF'
#!/bin/bash
echo "Starting Tricorder services..."
sudo systemctl start tricorder-camera
sudo systemctl start tricorder-display
echo "Services started!"
echo "Camera stream: http://raspberrypi.local:8080"
echo "Display: http://raspberrypi.local:3000/tricorder-display.html"
EOF

chmod +x "/home/$ACTUAL_USER/start-tricorder.sh"
chown "$ACTUAL_USER:$ACTUAL_USER" "/home/$ACTUAL_USER/start-tricorder.sh"
print_status "Startup script created"

# Create helper script
cat > "/home/$ACTUAL_USER/stop-tricorder.sh" << 'EOF'
#!/bin/bash
echo "Stopping Tricorder services..."
sudo systemctl stop tricorder-camera
sudo systemctl stop tricorder-display
echo "Services stopped!"
EOF

chmod +x "/home/$ACTUAL_USER/stop-tricorder.sh"
chown "$ACTUAL_USER:$ACTUAL_USER" "/home/$ACTUAL_USER/stop-tricorder.sh"
print_status "Stop script created"

# Create status script
cat > "/home/$ACTUAL_USER/tricorder-status.sh" << 'EOF'
#!/bin/bash
echo "================================"
echo "Tricorder Status"
echo "================================"
echo ""
echo "Camera Service:"
systemctl status tricorder-camera --no-pager
echo ""
echo "Display Service:"
systemctl status tricorder-display --no-pager
echo ""
echo "Camera Stream Test:"
curl -s -I http://localhost:8080/ | head -1
echo ""
EOF

chmod +x "/home/$ACTUAL_USER/tricorder-status.sh"
chown "$ACTUAL_USER:$ACTUAL_USER" "/home/$ACTUAL_USER/tricorder-status.sh"
print_status "Status script created"

echo ""
print_status "============================================"
print_status "Setup Complete!"
print_status "============================================"
echo ""
echo "Next steps:"
echo ""
echo "1. Verify webcam is connected:"
echo "   $ v4l2-ctl --list-devices"
echo ""
echo "2. Test camera stream manually:"
echo "   $ python3 $WORKSPACE_DIR/tricorder_camera_stream.py"
echo ""
echo "3. Start services:"
echo "   $ sudo systemctl start tricorder-camera"
echo "   $ sudo systemctl start tricorder-display"
echo ""
echo "4. Check status:"
echo "   $ ~/tricorder-status.sh"
echo ""
echo "5. Access services:"
echo "   - Main display: http://raspberrypi.local:3000/tricorder-display.html"
echo "   - Camera feed: http://raspberrypi.local:8080"
echo "   - Camera stream: http://raspberrypi.local:8080/stream"
echo ""
echo "Useful commands:"
echo "  ~/start-tricorder.sh    - Start all services"
echo "  ~/stop-tricorder.sh     - Stop all services"
echo "  ~/tricorder-status.sh   - Check service status"
echo "  sudo systemctl logs tricorder-camera -f  - View camera logs"
echo ""
echo "For troubleshooting, see: TRICORDER_SETUP.md"
echo ""
