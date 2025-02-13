from PIL import Image
from glob import glob
import time

numbers = '0123456789'
dim = 96
times = []

to_dice = glob('play.pokemonshowdown.com/sprites/fusion-sprites/Graphics/CustomBattlers/spritesheets/spritesheets_custom/*/*.png')
todo = len(to_dice)
counter = 0

for dir in to_dice:
    start = time.time()
    head = dir.split('/')[-2]
    alt = dir.split('/')[-1].split('.')[0][-1] if dir.split('/')[-1].split('.')[0][-1] not in numbers else ''
    full_sheet = Image.open(dir)

    width, height = full_sheet.size

    for num in range(0, int(height / dim) * int(width / dim)):
        cropped = full_sheet.crop(((num % 20) * dim, int(num / 20) * dim, ((num % 20) * dim) + dim, (int(num / 20) * dim) + dim))
        colors = cropped.getcolors()
        if colors and len(colors) != 1:
            cropped.save('play.pokemonshowdown.com/sprites/fusion-sprites/Graphics/CustomBattlers/' + head + '.' + str(num) + alt + '.png')

    times.append(time.time() - start)
    seconds_left = int((sum(times) / len(times)) * (todo - counter))
    print(f'{int(seconds_left / 60)}m {seconds_left % 60}s left        ', end="\r")
    counter += 1
